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
let tradeHistory = []; // Added History
let lastTradePerCoin = {};
let lastKnownBal = 0;
let lossStreak = 0;
let dailyLoss = 0; // Added Daily Loss Tracker

app.use(express.static('public'));

const botLog = (msg) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${msg}`);
};

// Load state on boot
if (fs.existsSync(STATE_FILE)) {
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { activeTrades = []; }
}
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
const getPrecision = (s) => ({ 'DOGE': 4, 'BTC': 5, 'ETH': 5 }[s] || 2);
const safe = (v, p = 4) => v ? v.toFixed(p) : "N/A";

// --- DASHBOARD APIs ---
app.get('/status', (req, res) => res.json({ 
    status: lossStreak >= 5 ? "HALTED" : "ACTIVE", 
    activeTrades, 
    balance: lastKnownBal, 
    streak: lossStreak,
    dailyLoss: dailyLoss.toFixed(2)
}));

app.get('/history', (req, res) => res.json(tradeHistory)); // Added History API

app.get('/indicators/:coin', async (req, res) => {
    const candles = await getCandles(req.params.coin);
    if (candles.length < 30) return res.json({});
    const closes = candles.map(c => c.close);
    res.json({
        closes: closes.slice(-30),
        rsi: RSI.calculate({ values: closes, period: 14 }).slice(-30),
        ema9: EMA.calculate({ values: closes, period: 9 }).slice(-30),
        ema21: EMA.calculate({ values: closes, period: 21 }).slice(-30),
        activeEntry: activeTrades.find(t => t.symbol === req.params.coin)?.entry || null
    });
});

// --- CORE UTILS ---
const signDCX = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY)
    .update(Buffer.from(JSON.stringify(body)).toString()).digest('hex');

const getCandles = async (symbol) => {
    try {
        const res = await axios.get(`https://public.coindcx.com/market_data/candles?pair=${symbol}USDT&interval=1m`);
        return Array.isArray(res.data) ? res.data.map(d => ({ 
            close: parseFloat(d.close), 
            high: parseFloat(d.high), 
            low: parseFloat(d.low) 
        })).reverse() : [];
    } catch { return []; }
};

// --- EXECUTION ENGINE ---
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
    } catch (e) {
        botLog(`❌ ${symbol} ${side.toUpperCase()} Error: ${e.response?.data?.message || e.message}`);
        return null;
    }
}

// --- MAIN SCANNER ---
const runScanner = async () => {
    botLog("🔍 Scanning...");
    
    if (lossStreak >= 5) return botLog("🛑 KILL SWITCH: 5 Losses.");

    // 1. Daily Loss Limit Check
    if (dailyLoss > lastKnownBal * 0.05) {
        botLog("🛑 Daily loss limit (5%) hit. Trading paused.");
        return;
    }

    // 2. BTC Market Regime Filter
    const btcCandles = await getCandles('BTC');
    if (btcCandles.length > 21) {
        const btcCloses = btcCandles.map(c => c.close);
        const btcTrend = EMA.calculate({ values: btcCloses, period: 21 }).pop();
        if (btcCloses[btcCloses.length - 1] < btcTrend) {
            return botLog("🐻 Market Regime: Bearish (BTC < EMA21). Skipping entries.");
        }
    }

    for (let i = activeTrades.length - 1; i >= 0; i--) { await checkExits(activeTrades[i], i); }
    if (activeTrades.length >= 4) return;

    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdt = bRes.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) - parseFloat(usdt.locked_balance || 0) : 0;
    } catch (e) { return botLog("⚠️ Balance Error."); }

    for (const coin of WATCHLIST) {
        if (activeTrades.find(t => t.symbol === coin)) continue;
        if (Date.now() - (lastTradePerCoin[coin] || 0) < 90000) continue; // 1.5m Cooldown

        const candles = await getCandles(coin);
        if (candles.length < 30) continue;

        const closes = candles.map(c => c.close);
        const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();
        const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
        const atr = ATR.calculate({ high: candles.map(c => c.high), low: candles.map(c => c.low), close: closes, period: 14 }).pop();

        // New Logic: Trend Strength & Momentum
        const trendStrength = Math.abs(ema9 - ema21) / closes[closes.length - 1] * 100;
        const fastMomentum = (closes[closes.length-1] - closes[closes.length-2]) / closes[closes.length-2] * 100;
        const volatility = (atr / closes[closes.length-1]) * 100;

        if (trendStrength < 0.05) continue; 
        if (fastMomentum < 0.03) continue;
        if (rsi > 70) continue; // Avoid overbought
        if (volatility < 0.08) continue; // Sideways filter

        const isBull = ema9 > ema21;
        let score = (rsi < 60 ? 1 : 0) + (isBull ? 1 : 0) + (closes[closes.length - 1] > closes[closes.length - 2] ? 1 : 0);

        if (score >= 2 && isBull && lastKnownBal > 5) {
            const tradeAmt = (lastKnownBal * 0.15).toFixed(2); // Reduced Position Size
            const bought = await executeOrder("buy", coin, tradeAmt);
            if (bought) {
                activeTrades.push({ 
                    symbol: coin, entry: bought.price, qty: bought.qty, highest: bought.price, 
                    stop: atr ? atr * 1.2 : bought.price * 0.012 // Tightened Stop
                });
                lastTradePerCoin[coin] = Date.now();
                saveState();
                fs.appendFileSync(LOG_FILE, `🚀 BUY: ${coin} @ ${bought.price}\n`);
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

        // Faster Exit Logic
        if ((gain > (0.7 + FEES) && drop > 0.3) || gain < -stopPct) {
            const sold = await executeOrder("sell", t.symbol, 0, t.qty);
            if (sold) {
                const pnlUSDT = (p - t.entry) * t.qty;
                
                // Track Daily Loss
                if (gain < 0) dailyLoss += Math.abs(pnlUSDT);
                lossStreak = (gain <= 0) ? lossStreak + 1 : 0;

                // Push to Trade History
                tradeHistory.push({
                    symbol: t.symbol, entry: t.entry, exit: p,
                    pnl: pnlUSDT.toFixed(2), percent: gain.toFixed(2), time: new Date().toLocaleTimeString()
                });

                fs.appendFileSync(LOG_FILE, `🚪 SELL: ${t.symbol} | PnL: ${gain.toFixed(2)}% ($${pnlUSDT.toFixed(2)})\n`);
                activeTrades.splice(idx, 1);
                saveState();
            }
        }
    } catch (e) {}
}

app.listen(PORT, '0.0.0.0', () => {
    botLog(`✅ APEX PRO v11.9 ACTIVE | PORT ${PORT}`);
    runScanner();
    cron.schedule('*/30 * * * * *', runScanner);
});

setInterval(() => { axios.get(`https://cryptogrowth-ai.onrender.com/status`).catch(() => {}); }, 240000);
