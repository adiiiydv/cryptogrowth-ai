const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA, ATR } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. RENDER BINDING & NEW CHART ENDPOINT ---
app.get('/', (req, res) => res.json({ status: "Live", active: activeTrades.length, balance: lastKnownBal }));

app.get('/chart/:coin', async (req, res) => {
    const candles = await getCandles(req.params.coin);
    res.json(candles);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ APEX PRO V11.2 DETECTIVE LIVE | PORT ${PORT}`);
});

// --- 2. CONFIG & STATE ---
const WATCHLIST = ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'MATIC', 'ADA', 'XRP'];
const STATE_FILE = './bot_state.json';
let activeTrades = [];
let lastTradePerCoin = {};
let lastKnownBal = 0;
let lossStreak = 0; 

const getPrecision = (s) => ({ 'DOGE': 4, 'BTC': 5, 'ETH': 5 }[s] || 2);
const safe = (v) => v ? v.toFixed(4) : "N/A";

if (fs.existsSync(STATE_FILE)) {
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { activeTrades = []; }
}
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));

// --- 3. CORE UTILITIES ---
const signDCX = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY)
    .update(Buffer.from(JSON.stringify(body)).toString()).digest('hex');

const getCandles = async (symbol) => {
    try {
        const res = await axios.get(`https://public.coindcx.com/market_data/candles?pair=${symbol}USDT&interval=1m`);
        if (!Array.isArray(res.data)) return [];
        return res.data.map(d => ({ 
            close: parseFloat(d.close), 
            high: parseFloat(d.high), 
            low: parseFloat(d.low) 
        })).reverse();
    } catch { return []; }
};

// --- 4. EXECUTION ENGINE ---
async function executeOrder(side, symbol, amount, exactQty = null) {
    try {
        const ticker = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${symbol}USDT`);
        const price = parseFloat(ticker.data.last_price);
        const precision = getPrecision(symbol);
        const qty = exactQty ? Number(exactQty.toFixed(precision)) : Number((amount / price).toFixed(precision));

        if (!qty || qty <= 0) return null;

        const body = { side, order_type: "market_order", market: `${symbol}USDT`, total_quantity: qty, timestamp: Date.now() };
        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });

        console.log(`🎯 ${side.toUpperCase()} SUCCESS: ${symbol} @ ${price}`);
        return { price, qty };
    } catch (e) {
        console.log(`❌ ORDER FAILED [${symbol}]:`, e.response?.data?.message || e.message);
        return null;
    }
}

// --- 5. MAIN SCANNER ---
const runScanner = async () => {
    if (lossStreak >= 3) return;

    for (let i = activeTrades.length - 1; i >= 0; i--) {
        await checkExits(activeTrades[i], i);
    }

    if (activeTrades.length >= 4) return;

    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdt = bRes.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) - parseFloat(usdt.locked_balance || 0) : 0;
    } catch (e) { return; }

    for (const coin of WATCHLIST) {
        if (activeTrades.find(t => t.symbol === coin)) continue;
        if (Date.now() - (lastTradePerCoin[coin] || 0) < 90000) continue;

        const candles = await getCandles(coin);
        if (candles.length < 30) continue;

        const closes = candles.map(c => c.close);
        const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();
        const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
        const atr = ATR.calculate({ high: candles.map(c => c.high), low: candles.map(c => c.low), close: closes, period: 14 }).pop();

        const isBullTrend = ema9 > ema21;
        let score = 0;
        if (rsi < 60) score++;
        if (isBullTrend) score++;
        if (closes[closes.length - 1] > closes[closes.length - 2]) score++;

        // 🔥 DETECTIVE VIEW LOGGING
        console.log(`
📊 ${coin}
Price: ${closes[closes.length - 1]}
RSI: ${safe(rsi)}
EMA9: ${safe(ema9)}
EMA21: ${safe(ema21)}
ATR: ${safe(atr)}
Trend: ${isBullTrend ? "BULL 🟢" : "BEAR 🔴"}
Score: ${score}/3
        `);

        if (!isBullTrend) continue;

        if (score >= 3 && lastKnownBal > 5) {
            const tradeAmt = Math.min(lastKnownBal * 0.25, lastKnownBal / (4 - activeTrades.length)).toFixed(2);
            const bought = await executeOrder("buy", coin, tradeAmt);
            if (bought) {
                activeTrades.push({ 
                    symbol: coin, 
                    entry: bought.price, 
                    qty: bought.qty, 
                    highest: bought.price, 
                    stop: atr * 1.5 
                });
                lastTradePerCoin[coin] = Date.now();
                saveState();
            }
        }
    }
};

// --- 6. EXIT LOGIC ---
async function checkExits(t, idx) {
    try {
        const ticker = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${t.symbol}USDT`);
        const p = parseFloat(ticker.data.last_price);
        if (p > t.highest) t.highest = p;

        const gain = ((p - t.entry) / t.entry) * 100;
        const drop = ((t.highest - p) / t.highest) * 100;
        const stopPercent = (t.stop / t.entry) * 100;

        if ((gain > 0.8 && drop > 0.3) || gain < -stopPercent) {
            const sold = await executeOrder("sell", t.symbol, 0, t.qty);
            if (sold) {
                lossStreak = (gain <= 0) ? lossStreak + 1 : 0;
                activeTrades.splice(idx, 1);
                saveState();
            }
        }
    } catch (e) {}
}

cron.schedule('*/15 * * * * *', runScanner);
