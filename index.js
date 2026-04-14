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

// Hourly Quota Settings
const TARGET_TRADES_PER_HOUR = 4;
let tradesThisHour = 0;
let lastHour = new Date().getHours();

let activeTrades = [];
let tradeHistory = []; 
let lastTradePerCoin = {};
let lastKnownBal = 0;
let lossStreak = 0;
let dailyLoss = 0; 

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
    dailyLoss: dailyLoss.toFixed(2),
    tradesThisHour
}));

app.get('/history', (req, res) => res.json(tradeHistory));

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
        if (side === "buy" && amount < 2 && !exactQty) return null;
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
    const currentHour = new Date().getHours();
    if (currentHour !== lastHour) {
        tradesThisHour = 0;
        lastHour = currentHour;
    }

    botLog(`🔍 Smart Scan | Trades: ${tradesThisHour}/${TARGET_TRADES_PER_HOUR}`);
    
    if (lossStreak >= 5) return botLog("🛑 STOP: Loss streak hit");
    if (tradesThisHour >= TARGET_TRADES_PER_HOUR) return botLog("⏳ Hourly quota reached");

    // 1. Balance Refresh
    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdt = bRes.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) - parseFloat(usdt.locked_balance || 0) : 0;
        botLog(`💰 Wallet Balance: $${lastKnownBal.toFixed(2)} USDT`);
    } catch (e) { return botLog("⚠️ Balance Error"); }

    if (dailyLoss > (lastKnownBal + dailyLoss) * 0.05) return botLog("🛑 Daily loss limit hit");

    // 2. BTC Market Regime
    let marketIsBullish = true;
    const btcCandles = await getCandles('BTC');
    if (btcCandles.length > 21) {
        const btcCloses = btcCandles.map(c => c.close);
        const btcEMA = EMA.calculate({ values: btcCloses, period: 21 }).pop();
        marketIsBullish = btcCloses.at(-1) > btcEMA;
        botLog(marketIsBullish ? "🚀 Market: BULLISH" : "🐻 Market: BEARISH");
    }

    // 3. Scan Watchlist
    for (const coin of WATCHLIST) {
        if (activeTrades.length >= 4) break;
        if (tradesThisHour >= TARGET_TRADES_PER_HOUR) break;
        if (activeTrades.find(t => t.symbol === coin)) continue;
        if (Date.now() - (lastTradePerCoin[coin] || 0) < 60000) continue; 

        const candles = await getCandles(coin);
        if (candles.length < 30) continue;

        const closes = candles.map(c => c.close);
        const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();
        const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
        const atr = ATR.calculate({ high: candles.map(c => c.high), low: candles.map(c => c.low), close: closes, period: 14 }).pop();

        const price = closes.at(-1);
        const momentum = price > closes.at(-2);
        const isBull = ema9 > ema21;
        const volatility = (atr / price) * 100;

        // 4-CONDITION SCORE SYSTEM
        let score = 0;
        if (rsi < 60) score++;
        if (isBull) score++;
        if (momentum) score++;
        if (volatility > 0.1) score++;

        botLog(`📊 ${coin.padEnd(5)} | Score: ${score}/4 | RSI: ${safe(rsi, 1)} | Vol: ${volatility.toFixed(2)}% | Trend: ${isBull ? "🟢" : "🔴"}`);

        // ✅ BALANCED ENTRY (Micro-Balance Friendly)
        if (score >= 3 && marketIsBullish && lastKnownBal > 2) {
            const tradeAmt = (lastKnownBal * 0.25).toFixed(2);
            const bought = await executeOrder("buy", coin, tradeAmt);
            if (bought) {
                activeTrades.push({ 
                    symbol: coin, entry: bought.price, qty: bought.qty, highest: bought.price, 
                    stop: atr ? atr * 1.5 : bought.price * 0.015 
                });
                lastTradePerCoin[coin] = Date.now();
                tradesThisHour++;
                saveState();
                botLog(`🚀 BUY ${coin} @ ${bought.price} | Trades this hour: ${tradesThisHour}`);
                fs.appendFileSync(LOG_FILE, `🚀 BUY: ${coin} @ ${bought.price}\n`);
            }
        }
    }

    // 4. Check Exits
    for (let i = activeTrades.length - 1; i >= 0; i--) { await checkExits(activeTrades[i], i); }
};

// --- SMART EXIT LOGIC ---
async function checkExits(t, idx) {
    try {
        const ticker = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${t.symbol}USDT`);
        const p = parseFloat(ticker.data.last_price);
        if (p > t.highest) t.highest = p;

        const gain = ((p - t.entry) / t.entry) * 100;
        const drop = ((t.highest - p) / t.highest) * 100;
        const stopPct = (t.stop / t.entry) * 100;

        // REAL PROFIT TARGET (1.2% + Fees)
        if ((gain > (1.2 + FEES) && drop > 0.3) || gain < -stopPct) {
            const sold = await executeOrder("sell", t.symbol, 0, t.qty);
            if (sold) {
                const pnl = (p - t.entry) * t.qty;
                if (gain < 0) dailyLoss += Math.abs(pnl);
                lossStreak = (gain <= 0) ? lossStreak + 1 : 0;
                
                tradeHistory.push({
                    symbol: t.symbol, entry: t.entry, exit: p,
                    pnl: pnl.toFixed(2), percent: gain.toFixed(2), time: new Date().toLocaleTimeString()
                });

                activeTrades.splice(idx, 1);
                saveState();
                botLog(`💰 EXIT ${t.symbol} | ${gain.toFixed(2)}% | PnL: $${pnl.toFixed(2)}`);
                fs.appendFileSync(LOG_FILE, `🚪 SELL: ${t.symbol} | PnL: ${gain.toFixed(2)}% ($${pnl.toFixed(2)})\n`);
            }
        }
    } catch (e) {}
}

app.listen(PORT, '0.0.0.0', () => {
    botLog(`✅ APEX PRO v11.9.5 SMART-BALANCED LIVE | PORT ${PORT}`);
    runScanner();
    cron.schedule('*/30 * * * * *', runScanner);
});

setInterval(() => { axios.get(`https://cryptogrowth-ai.onrender.com/status`).catch(() => {}); }, 240000);
