const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA, ATR } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ================= CONFIG & STATE =================
const WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'MATICUSDT', 'ADAUSDT', 'XRPUSDT'];
const STATE_FILE = './bot_state.json';
const STATS_FILE = './bot_stats.json';
const FEES = 0.25; 
const TARGET_TRADES_PER_HOUR = 4;

let tradesThisHour = 0;
let lastHour = new Date().getHours();
let activeTrades = [];
let lastTradePerCoin = {}; 
let lastKnownBal = 0;
let lossStreak = 0;
let stats = { totalTrades: 0, wins: 0, losses: 0, totalProfit: 0 };

// ================= PERSISTENCE =================
const loadData = () => {
    if (fs.existsSync(STATE_FILE)) activeTrades = JSON.parse(fs.readFileSync(STATE_FILE));
    if (fs.existsSync(STATS_FILE)) stats = JSON.parse(fs.readFileSync(STATS_FILE));
};
const saveData = () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
};
loadData();

const botLog = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

// ================= UTILS =================
const signDCX = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY)
    .update(JSON.stringify(body)).digest('hex');

const getCandles = async (symbol) => {
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=50`;
        const res = await axios.get(url, { timeout: 5000 });
        return res.data.map(d => ({ close: parseFloat(d[4]), high: parseFloat(d[2]), low: parseFloat(d[3]) }));
    } catch (e) { return []; }
};

// ================= FIXED ORDER ENGINE =================
async function executeOrder(side, binanceSymbol, amount, exactQty = null, retry = 2) {
    try {
        const coin = binanceSymbol.replace("USDT", "");
        const market = `B-${coin}_USDT`;

        // 1. Fetch Market Details for Precision
        const mDetails = await axios.get('https://api.coindcx.com/exchange/v1/markets_details', { timeout: 8000 });
        const mInfo = mDetails.data.find(m => m.symbol === market || m.coindcx_name === market || m.pair === market);
        
        if (!mInfo) {
            botLog(`❌ Market ID ${market} not supported by CoinDCX API.`);
            return null;
        }
        const precision = mInfo.target_currency_precision || 5;

        // 2. Fetch Ticker with Validation (Fixes "data: undefined" from your logs)
        const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker`, { timeout: 8000 });
        
        if (!tickerRes.data || !Array.isArray(tickerRes.data)) {
            throw new Error("Ticker API returned empty or invalid data");
        }

        const data = tickerRes.data.find(m => m.market === market || m.pair === market);
        if (!data || !data.last_price) {
            botLog(`❌ Price data missing for ${market} in Ticker response.`);
            return null;
        }

        const price = parseFloat(data.last_price);
        const qty = exactQty ? Number(exactQty.toFixed(precision)) : Number((amount / price).toFixed(precision));

        if (!qty || qty <= 0) {
            botLog(`❌ Calculation Error: Qty is ${qty}`);
            return null;
        }

        // 3. Strict Request Body
        const body = {
            side,
            order_type: "market_order",
            market: mInfo.symbol, // Use the official symbol from details
            total_quantity: qty,
            timestamp: Date.now()
        };

        const res = await axios.post("https://api.coindcx.com/exchange/v1/orders/create", body, {
            headers: {
                "X-AUTH-APIKEY": process.env.COINDCX_API_KEY,
                "X-AUTH-SIGNATURE": signDCX(body),
                "Content-Type": "application/json"
            },
            timeout: 10000
        });

        botLog(`✅ ${side.toUpperCase()} SUCCESS: ${market} | Qty: ${qty}`);
        return { price, qty, market: mInfo.symbol };

    } catch (e) {
        if (retry > 0) {
            botLog(`⚠️ Connection unstable. Retrying ${side}...`);
            return new Promise(resolve => setTimeout(() => resolve(executeOrder(side, binanceSymbol, amount, exactQty, retry - 1)), 2000));
        }
        botLog(`❌ FATAL ERROR: ${e.response?.data?.message || e.message}`);
        return null;
    }
}

// ================= MAIN LOOP =================
const runScanner = async () => {
    if (new Date().getHours() !== lastHour) { tradesThisHour = 0; lastHour = new Date().getHours(); }
    if (lossStreak >= 5) return botLog("🛑 BOT STOPPED: High Loss Streak.");

    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) },
            timeout: 8000
        });
        const usdt = (bRes.data || []).find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) - parseFloat(usdt.locked_balance || 0) : 0;
    } catch (e) { return botLog("⚠️ Balance Sync Failed"); }

    const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker`);
    const allTickers = tickerRes.data || [];

    botLog(`🔍 SCAN | Bal: $${lastKnownBal.toFixed(2)} | Tr: ${tradesThisHour}/4`);

    // Handle Exits
    for (let i = activeTrades.length - 1; i >= 0; i--) {
        const t = activeTrades[i];
        const ticker = allTickers.find(m => m.market === t.marketId);
        if (!ticker) continue;

        const p = parseFloat(ticker.last_price);
        if (p > t.highest) t.highest = p;

        const gain = ((p - t.entry) / t.entry) * 100;
        const drop = ((t.highest - p) / t.highest) * 100;
        const stopPct = (t.stop / t.entry) * 100;

        if ((gain > (1.2 + FEES) && drop > 0.3) || gain < -stopPct) {
            const sold = await executeOrder("sell", t.symbol, 0, t.qty);
            if (sold) {
                stats.totalTrades++;
                stats.totalProfit += gain;
                if (gain > 0) { stats.wins++; lossStreak = 0; }
                else { stats.losses++; lossStreak++; }
                activeTrades.splice(i, 1);
                saveData();
            }
        }
    }

    // Handle Entries
    for (const coin of WATCHLIST) {
        if (activeTrades.find(t => t.symbol === coin)) continue;
        const candles = await getCandles(coin);
        if (candles.length < 30) continue;

        const closes = candles.map(c => c.close);
        const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();
        const atr = ATR.calculate({ high: candles.map(c=>c.high), low: candles.map(c=>c.low), close: closes, period: 14 }).pop();

        const score = (rsi < 60 ? 1 : 0) + (ema9 > ema21 ? 1 : 0) + (closes.at(-1) > closes.at(-2) ? 1 : 0);
        
        if (score === 3 && tradesThisHour < TARGET_TRADES_PER_HOUR && lastKnownBal > 5.0) {
            const bought = await executeOrder("buy", coin, lastKnownBal * 0.45);
            if (bought) {
                activeTrades.push({ symbol: coin, marketId: bought.market, entry: bought.price, qty: bought.qty, highest: bought.price, stop: atr ? atr * 1.5 : bought.price * 0.015 });
                tradesThisHour++;
                saveData();
            }
        }
    }
};

app.get('/status', (req, res) => res.json({ balance: lastKnownBal, activeTrades, stats }));

app.listen(PORT, '0.0.0.0', () => {
    botLog(`✅ APEX PRO v14.1 LIVE | PORT ${PORT}`);
    runScanner();
    cron.schedule('*/30 * * * * *', runScanner);
});
