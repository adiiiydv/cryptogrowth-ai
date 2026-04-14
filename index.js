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
const STATE_FILE = './state.json';
const STATS_FILE = './stats.json';
const FEES = 0.25; 
const TARGET_TRADES_PER_HOUR = 4;

let activeTrades = [];
let lastKnownBal = 0;
let tradesThisHour = 0;
let lastHour = new Date().getHours();
let stats = { totalTrades: 0, wins: 0, losses: 0, totalProfit: 0 };

// ================= PERSISTENCE =================
const loadData = () => {
    if (fs.existsSync(STATE_FILE)) activeTrades = JSON.parse(fs.readFileSync(STATE_FILE));
    if (fs.existsSync(STATS_FILE)) stats = JSON.parse(fs.readFileSync(STATS_FILE));
};
const saveData = () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades, null, 2));
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
};
loadData();

const botLog = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const signDCX = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(JSON.stringify(body)).digest('hex');

// ================= MARKET DATA =================
async function getCandles(symbol) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=50`, { timeout: 6000 });
        return res.data.map(c => ({ close: parseFloat(c[4]), high: parseFloat(c[2]), low: parseFloat(c[3]) }));
    } catch { return []; }
}

// ================= ULTRA-STRONG ENGINE v15.0 =================
async function executeOrder(side, binanceSymbol, amount, exactQty = null, retry = 3) {
    try {
        const coin = binanceSymbol.replace("USDT", "");
        
        // 1. DYNAMIC MARKET RESOLUTION (Fixes "not_found")
        const mDetails = await axios.get('https://api.coindcx.com/exchange/v1/markets_details', { timeout: 15000 });
        const mInfo = mDetails.data.find(m => 
            m.symbol === `B-${coin}_USDT` || m.coindcx_name === `B-${coin}_USDT` || m.pair === `${coin}USDT`
        );
        
        if (!mInfo) {
            botLog(`❌ CRITICAL: Market for ${coin} not found.`);
            return null;
        }

        const market = mInfo.symbol; 
        const precision = mInfo.target_currency_precision || 5;

        // 2. TICKER VALIDATION (Fixes "data: undefined")
        const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker`, { timeout: 20000 });
        if (!tickerRes.data || !Array.isArray(tickerRes.data)) throw new Error("Ticker Data Empty");

        const data = tickerRes.data.find(m => m.market === market || m.pair === market);
        const price = data ? parseFloat(data.last_price) : 0;

        // FIX: INVALID PRICE SKIP
        if (!price || price <= 0) {
            botLog("❌ INVALID PRICE SKIP ORDER");
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
            timeout: 25000
        });

        // FIX: STRONGER REJECTION CHECK
        if (!res.data || res.data.status === "error" || res.data.code) {
            botLog("❌ ORDER REJECTED BY EXCHANGE");
            return null;
        }

        botLog(`✅ ${side.toUpperCase()} SUCCESS: ${market} @ ${price}`);
        return { price, qty, market };

    } catch (e) {
        if (retry > 0) {
            botLog(`⚠️ Retrying ${side}...`);
            return new Promise(resolve => setTimeout(() => resolve(executeOrder(side, binanceSymbol, amount, exactQty, retry - 1)), 5000));
        }
        botLog(`❌ FATAL: ${e.message}`);
        return null;
    }
}

// ================= SCANNER LOGIC =================
const runScanner = async () => {
    if (new Date().getHours() !== lastHour) { tradesThisHour = 0; lastHour = new Date().getHours(); }

    // 1. BALANCE FETCH
    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) },
            timeout: 15000
        });
        const usdt = (bRes.data || []).find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) - parseFloat(usdt.locked_balance || 0) : 0;
    } catch (e) { return botLog("⚠️ Balance Sync Failed"); }

    const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker`, { timeout: 15000 });
    const allTickers = tickerRes.data || [];

    botLog(`🔍 SCAN | Bal: $${lastKnownBal.toFixed(2)} | Tr: ${tradesThisHour}/4`);

    // 2. EXIT LOGIC (ATR Stop Loss + Trailing)
    for (let i = activeTrades.length - 1; i >= 0; i--) {
        const t = activeTrades[i];
        const ticker = allTickers.find(m => m.market === t.market || m.pair === t.market);
        if (!ticker) continue;

        const p = parseFloat(ticker.last_price);
        if (p > t.highest) t.highest = p;

        const gain = ((p - t.entry) / t.entry) * 100;
        const dropFromTop = ((t.highest - p) / t.highest) * 100;

        if ((gain > (1.2 + FEES) && dropFromTop > 0.3) || gain < -0.8) {
            const sold = await executeOrder("sell", t.symbol, 0, t.qty);
            if (sold) {
                stats.totalTrades++;
                stats.totalProfit += gain;
                if (gain > 0) stats.wins++; else stats.losses++;
                activeTrades.splice(i, 1);
                saveData();
            }
        }
    }

    // 3. ENTRY LOGIC
    for (const coin of WATCHLIST) {
        if (activeTrades.find(t => t.symbol === coin)) continue;
        const candles = await getCandles(coin);
        if (candles.length < 30) continue;

        const closes = candles.map(c => c.close);
        const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();

        if (rsi < 60 && ema9 > ema21 && tradesThisHour < TARGET_TRADES_PER_HOUR && lastKnownBal > 5.0) {
            // FIX: SAFER TRADE AMOUNT
            const tradeAmt = Math.min(Math.max(lastKnownBal * 0.25, 2), 20);
            
            const bought = await executeOrder("buy", coin, tradeAmt);
            if (bought) {
                activeTrades.push({ 
                    symbol: coin, 
                    market: bought.market, 
                    entry: bought.price, 
                    qty: bought.qty, 
                    highest: bought.price 
                });
                tradesThisHour++;
                saveData();
            }
        }
    }
};

// ================= SERVER & ROUTES =================
app.get('/status', (req, res) => res.json({ balance: lastKnownBal, activeTrades, stats }));

app.listen(PORT, () => {
    botLog(`🚀 APEX PRO v15.0 FINAL STABILIZED LIVE`);
    runScanner();
    cron.schedule('*/30 * * * * *', runScanner);
});
