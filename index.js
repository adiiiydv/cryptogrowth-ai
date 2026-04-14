const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA, ATR } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIG & STATE ---
const WATCHLIST = ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'MATIC', 'ADA', 'XRP'];
const STATE_FILE = './bot_state.json';
const LOG_FILE = './trades.log';
const FEES = 0.25; 
let activeTrades = [];
let lastTradePerCoin = {};
let lastKnownBal = 0;
let lossStreak = 0;

app.use(express.static('public'));

if (fs.existsSync(STATE_FILE)) {
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { activeTrades = []; }
}
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
const getPrecision = (s) => ({ 'DOGE': 4, 'BTC': 5, 'ETH': 5 }[s] || 2);

// --- DASHBOARD APIs ---
app.get('/status', (req, res) => {
    // Calculate live PnL for each active trade
    const tradesWithPnL = activeTrades.map(t => ({...t, currentPnL: 0})); 
    res.json({ status: lossStreak >= 5 ? "HALTED" : "ACTIVE", activeTrades, balance: lastKnownBal, streak: lossStreak });
});

app.get('/indicators/:coin', async (req, res) => {
    const candles = await getCandles(req.params.coin);
    if (candles.length < 30) return res.json({});
    const closes = candles.map(c => c.close);
    res.json({
        closes: closes.slice(-30),
        rsi: RSI.calculate({ values: closes, period: 14 }).slice(-30),
        ema9: EMA.calculate({ values: closes, period: 9 }).slice(-30),
        ema21: EMA.calculate({ values: closes, period: 21 }).slice(-30),
        // Send entry price if coin is currently being traded
        activeEntry: activeTrades.find(t => t.symbol === req.params.coin)?.entry || null
    });
});

// --- CORE LOGIC ---
const signDCX = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(Buffer.from(JSON.stringify(body)).toString()).digest('hex');

const getCandles = async (symbol) => {
    try {
        const res = await axios.get(`https://public.coindcx.com/market_data/candles?pair=${symbol}USDT&interval=1m`);
        return Array.isArray(res.data) ? res.data.map(d => ({ close: parseFloat(d.close), high: parseFloat(d.high), low: parseFloat(d.low) })).reverse() : [];
    } catch { return []; }
};

async function executeOrder(side, symbol, amount, exactQty = null) {
    try {
        if (side === "buy" && amount < 4 && !exactQty) return null;
        const ticker = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${symbol}USDT`);
        const price = parseFloat(ticker.data.last_price);
        const qty = exactQty ? Number(exactQty.toFixed(getPrecision(symbol))) : Number((amount / price).toFixed(getPrecision(symbol)));
        if (!qty || qty <= 0) return null;

        const body = { side, order_type: "market_order", market: `${symbol}USDT`, total_quantity: qty, timestamp: Date.now() };
        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        return { price, qty };
    } catch (e) { return null; }
}

const runScanner = async () => {
    if (lossStreak >= 5) return;
    for (let i = activeTrades.length - 1; i >= 0; i--) { await checkExits(activeTrades[i], i); }
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

        // VOLATILITY FILTER: Skip if market is dead/sideways
        const volatility = (atr / closes[closes.length-1]) * 100;
        if (volatility < 0.15) continue; 

        const isBull = ema9 > ema21;
        let score = (rsi < 60 ? 1 : 0) + (isBull ? 1 : 0) + (closes[closes.length - 1] > closes[closes.length - 2] ? 1 : 0);

        if (score >= 3 && lastKnownBal > 5) {
            const tradeAmt = Math.min(lastKnownBal * 0.25, lastKnownBal / (4 - activeTrades.length)).toFixed(2);
            const bought = await executeOrder("buy", coin, tradeAmt);
            if (bought) {
                activeTrades.push({ symbol: coin, entry: bought.price, qty: bought.qty, highest: bought.price, stop: atr ? atr * 1.5 : bought.price * 0.015 });
                lastTradePerCoin[coin] = Date.now();
                saveState();
                fs.appendFileSync(LOG_FILE, `🚀 BUY: ${coin} @ ${bought.price} | Qty: ${bought.qty} | Time: ${new Date().toLocaleString()}\n`);
            }
        }
    }
};

async function checkExits(t, idx) {
    try {
        const ticker = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${t.symbol}USDT`);
        const p = parseFloat(ticker.data.last_price);
        if (p > t.highest) t.highest = p;
        const gain = ((p - t.entry) / t.entry) * 100;
        const drop = ((t.highest - p) / t.highest) * 100;
        const stopPct = (t.stop / t.entry) * 100;

        if ((gain > (0.8 + FEES) && drop > 0.3) || gain < -stopPct) {
            const sold = await executeOrder("sell", t.symbol, 0, t.qty);
            if (sold) {
                const pnlUSDT = (p - t.entry) * t.qty; // REAL USDT PNL
                lossStreak = (gain <= 0) ? lossStreak + 1 : 0;
                fs.appendFileSync(LOG_FILE, `🚪 SELL: ${t.symbol} | PnL%: ${gain.toFixed(2)}% | PnL $: ${pnlUSDT.toFixed(2)} | Streak: ${lossStreak}\n`);
                activeTrades.splice(idx, 1);
                saveState();
            }
        }
    } catch (e) {}
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ APEX PRO v11.6 ANALYTICS LIVE`);
    cron.schedule('*/15 * * * * *', runScanner);
});
