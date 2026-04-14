const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA, ATR } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIG ---
// Use Binance naming (e.g., BTCUSDT)
const WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'MATICUSDT', 'ADAUSDT', 'XRPUSDT'];
const STATE_FILE = './bot_state.json';
const FEES = 0.25; 

const TARGET_TRADES_PER_HOUR = 4;
let tradesThisHour = 0;
let lastHour = new Date().getHours();
let activeTrades = [];
let lastTradePerCoin = {}; 
let lastKnownBal = 0;
let lossStreak = 0;

const botLog = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

if (fs.existsSync(STATE_FILE)) {
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { activeTrades = []; }
}
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
const safe = (v, p = 2) => v ? v.toFixed(p) : "0.00";

// --- RELIABLE DATA SOURCE (BINANCE) ---
const getCandles = async (symbol) => {
    try {
        // Switching to Binance for 100% data reliability
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=50`;
        const res = await axios.get(url, { timeout: 5000 });
        return res.data.map(d => ({
            close: parseFloat(d[4]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3])
        }));
    } catch (e) {
        return [];
    }
};

const signDCX = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY)
    .update(Buffer.from(JSON.stringify(body)).toString()).digest('hex');

async function executeOrder(side, symbol, amount, exactQty = null) {
    try {
        const ticker = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${symbol}`);
        let price = parseFloat(ticker.data.last_price);
        const qty = exactQty ? Number(exactQty.toFixed(5)) : Number((amount / price).toFixed(5));
        
        if (!qty || qty <= 0) return null;

        const body = { side, order_type: "market_order", market: symbol, total_quantity: qty, timestamp: Date.now() };
        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        return { price, qty };
    } catch (e) {
        botLog(`❌ Order Fail: ${e.response?.data?.message || e.message}`);
        return null;
    }
}

const runScanner = async () => {
    if (new Date().getHours() !== lastHour) { tradesThisHour = 0; lastHour = new Date().getHours(); }
    if (lossStreak >= 5) return botLog("🛑 HALTED");

    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdt = (bRes.data || []).find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) - parseFloat(usdt.locked_balance || 0) : 0;
    } catch (e) { return botLog("⚠️ Bal Err"); }

    botLog(`🔍 SCAN | Bal: $${lastKnownBal.toFixed(2)} | Quota: ${tradesThisHour}/${TARGET_TRADES_PER_HOUR}`);

    for (const coin of WATCHLIST) {
        const candles = await getCandles(coin);
        if (candles.length < 30) {
            botLog(`📡 ${coin.padEnd(7)} | ⚠️ No Binance Data`);
            continue;
        }

        const closes = candles.map(c => c.close);
        const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();
        const rsi = RSI.calculate({ values: closes, period: 14 }).pop();

        const score = (rsi < 60 ? 1 : 0) + (ema9 > ema21 ? 1 : 0) + (closes.at(-1) > closes.at(-2) ? 1 : 0);
        botLog(`📊 ${coin.padEnd(7)} | RSI: ${safe(rsi)} | Score: ${score}/3`);

        if (activeTrades.find(t => t.symbol === coin) || score < 3 || lastKnownBal < 2.0) continue;

        const bought = await executeOrder("buy", coin, (lastKnownBal * 0.50).toFixed(2));
        if (bought) {
            activeTrades.push({ symbol: coin, entry: bought.price, qty: bought.qty });
            tradesThisHour++;
            saveState();
            botLog(`🚀 BOUGHT ${coin}`);
        }
    }
};

app.get('/status', (req, res) => res.json({ activeTrades, balance: lastKnownBal }));

app.listen(PORT, '0.0.0.0', () => {
    botLog(`✅ APEX PRO v12.2 BINANCE-LINKED | PORT ${PORT}`);
    runScanner();
    cron.schedule('*/30 * * * * *', runScanner);
});
