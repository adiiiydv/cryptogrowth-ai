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

// ================= STRONGER ORDER ENGINE v14.3 =================
async function executeOrder(side, binanceSymbol, amount, exactQty = null, retry = 2) {
    try {
        const coin = binanceSymbol.replace("USDT", "");
        
        // 1. DYNAMIC MARKET RESOLUTION (Fixes "not_found")
        const mDetails = await axios.get('https://api.coindcx.com/exchange/v1/markets_details', { timeout: 8000 });
        const possibleNames = [`B-${coin}_USDT`, `${coin}_USDT`, `${coin}USDT` ];
        
        const mInfo = mDetails.data.find(m => 
            possibleNames.includes(m.symbol) || 
            possibleNames.includes(m.coindcx_name) || 
            possibleNames.includes(m.pair)
        );
        
        if (!mInfo) {
            botLog(`❌ Market for ${coin} not found in any format.`);
            return null;
        }

        const market = mInfo.symbol; // The exact string the exchange expects
        const precision = mInfo.target_currency_precision || 5;

        // 2. TICKER VALIDATION (Fixes "data: undefined")
        const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker`, { timeout: 10000 });
        if (!tickerRes.data || !Array.isArray(tickerRes.data)) throw new Error("Ticker Data Undefined");

        const data = tickerRes.data.find(m => m.market === market || m.pair === market);
        
        // Improvement: Invalid Price Skip
        const price = data ? parseFloat(data.last_price) : 0;
        if (!price || price <= 0) {
            botLog(`❌ INVALID PRICE SKIP ORDER for ${market}`);
            return null;
        }

        const qty = exactQty ? Number(exactQty.toFixed(precision)) : Number((amount / price).toFixed(precision));
        if (!qty || qty <= 0) return null;

        // 3. STRONGER REJECTION HANDLING
        const body = {
            side,
            order_type: "market_order",
            market: market,
            total_quantity: qty,
            timestamp: Date.now()
        };

        const res = await axios.post("https://api.coindcx.com/exchange/v1/orders/create", body, {
            headers: {
                "X-AUTH-APIKEY": process.env.COINDCX_API_KEY,
                "X-AUTH-SIGNATURE": signDCX(body),
                "Content-Type": "application/json"
            },
            timeout: 12000
        });

        // Stronger Fix: Catch all error variants
        if (!res.data || res.data.status === "error" || res.data.code || res.data.message?.includes("fail")) {
            botLog(`❌ ORDER REJECTED BY EXCHANGE: ${res.data?.message || "Unknown error"}`);
            return null;
        }

        botLog(`✅ ${side.toUpperCase()} SUCCESS: ${market} @ ${price}`);
        return { price, qty, market };

    } catch (e) {
        if (retry > 0) {
            botLog(`⚠️ Retrying ${side}...`);
            return new Promise(resolve => setTimeout(() => resolve(executeOrder(side, binanceSymbol, amount, exactQty, retry - 1)), 3000));
        }
        botLog(`❌ FATAL: ${e.response?.data?.message || e.message}`);
        return null;
    }
}

// ================= SCANNER LOGIC =================
const runScanner = async () => {
    if (new Date().getHours() !== lastHour) { tradesThisHour = 0; lastHour = new Date().getHours(); }
    if (lossStreak >= 5) return botLog("🛑 STOPPED: High Risk Detected.");

    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdt = (bRes.data || []).find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) - parseFloat(usdt.locked_balance || 0) : 0;
    } catch (e) { return botLog("⚠️ Bal Sync Error"); }

    const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker`);
    const allTickers = tickerRes.data || [];

    botLog(`🔍 SCAN | Bal: $${lastKnownBal.toFixed(2)} | Tr: ${tradesThisHour}/4`);

    // Handle Exits
    for (let i = activeTrades.length - 1; i >= 0; i--) {
        const t = activeTrades[i];
        const ticker = allTickers.find(m => m.market === t.marketId || m.pair === t.marketId);
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
            // Safer Trade Amount: Min $2, Max $20, default 25% of balance
            const tradeAmt = Math.min(Math.max(lastKnownBal * 0.25, 2), 20);
            
            const bought = await executeOrder("buy", coin, tradeAmt);
            if (bought) {
                activeTrades.push({ 
                    symbol: coin, 
                    marketId: bought.market, 
                    entry: bought.price, 
                    qty: bought.qty, 
                    highest: bought.price, 
                    stop: atr ? atr * 1.5 : bought.price * 0.015 
                });
                tradesThisHour++;
                saveData();
            }
        }
    }
};

app.get('/status', (req, res) => res.json({ balance: lastKnownBal, activeTrades, stats }));

app.listen(PORT, '0.0.0.0', () => {
    botLog(`✅ APEX PRO v14.3 RECOVERY | PORT ${PORT}`);
    runScanner();
    cron.schedule('*/30 * * * * *', runScanner);
});
