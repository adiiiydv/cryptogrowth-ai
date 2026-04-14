const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA, ATR } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. CLARITY LOGGING & STATUS ---
app.get('/', (req, res) => res.json({ status: "Live", active: activeTrades.length, balance: lastKnownBal }));
app.listen(PORT, '0.0.0.0', () => console.log(`✅ PORT BINDING SUCCESS: Listening on ${PORT}`));

// --- 2. GLOBAL CONFIG & WATCHLIST ---
const WATCHLIST = ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'MATIC', 'ADA', 'XRP'];
const STATE_FILE = './bot_state.json';
let activeTrades = [];
let lastTradePerCoin = {};
let lastKnownBal = 0;

// Precision Map to solve the "DOGE Code 400" error
const getPrecision = (symbol) => {
    const map = { 'DOGE': 4, 'BTC': 5, 'ETH': 5, 'XRP': 2, 'ADA': 2, 'MATIC': 2, 'SOL': 2, 'BNB': 2 };
    return map[symbol] || 2;
};

// --- 3. STATE RECOVERY ---
if (fs.existsSync(STATE_FILE)) {
    try {
        activeTrades = JSON.parse(fs.readFileSync(STATE_FILE));
        console.log(`🔄 RECOVERED: ${activeTrades.length} trades back in memory.`);
    } catch (e) { activeTrades = []; }
}
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));

// --- 4. CORE UTILITIES ---
const signDCX = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

const getCandles = async (symbol, interval = "1m") => {
    try {
        const res = await axios.get(`https://public.coindcx.com/market_data/candles?pair=${symbol}USDT&interval=${interval}`);
        return res.data.map(d => ({
            close: parseFloat(d.close),
            high: parseFloat(d.high),
            low: parseFloat(d.low)
        })).reverse();
    } catch { return []; }
};

// --- 5. EXECUTION ENGINE (The Precision Fix) ---
async function executeOrder(side, symbol, amount, exactQty = null) {
    try {
        if (side === "buy" && amount < 4 && !exactQty) return null;

        const ticker = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${symbol}USDT`);
        const price = parseFloat(ticker.data.last_price);
        
        // FIX: Mapping precision before rounding
        const precision = getPrecision(symbol);
        const qty = exactQty ? 
            Number(exactQty.toFixed(precision)) : 
            Number((amount / price).toFixed(precision));

        if (!qty || qty <= 0) return null;

        const body = { 
            side, 
            order_type: "market_order", 
            market: `${symbol}USDT`, 
            total_quantity: qty, 
            timestamp: Date.now() 
        };

        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 
                'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 
                'X-AUTH-SIGNATURE': signDCX(body) 
            }
        });

        console.log(`🎯 ${side.toUpperCase()} SUCCESS: ${symbol} | Qty: ${qty} | Price: ${price}`);
        return { price, qty };
    } catch (e) {
        console.log(`❌ ORDER REJECTED [${symbol}]:`, e.response?.data?.message || e.message);
        return null;
    }
}

// --- 6. SCANNER & LOGIC ---
const runScanner = async () => {
    // Exit Check
    for (let i = activeTrades.length - 1; i >= 0; i--) {
        await checkExits(activeTrades[i], i);
    }

    if (activeTrades.length >= 4) return;

    // Balance Check
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

        const candles = await getCandles(coin, "1m");
        if (candles.length < 30) continue;

        const closes = candles.map(c => c.close);
        const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();
        const atr = ATR.calculate({ high: candles.map(c => c.high), low: candles.map(c => c.low), close: closes, period: 14 }).pop();

        let score = 0;
        if (rsi < 65) score++;
        if (ema9 > ema21) score++;
        if (closes[closes.length - 1] > closes[closes.length - 2]) score++;

        // ENTRY (Score 2+ for high activity)
        if (score >= 2 && lastKnownBal > 5) {
            const tradeAmt = Math.min(lastKnownBal * 0.35, lastKnownBal - 0.1).toFixed(2);
            const bought = await executeOrder("buy", coin, tradeAmt);
            if (bought) {
                activeTrades.push({
                    symbol: coin,
                    entry: bought.price,
                    qty: bought.qty,
                    highest: bought.price,
                    stop: Math.min(atr * 1.5, bought.price * 0.012) // Max 1.2% stop
                });
                lastTradePerCoin[coin] = Date.now();
                saveState();
            }
        }
    }
};

// --- 7. EXIT STRATEGY ---
async function checkExits(t, idx) {
    try {
        const ticker = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${t.symbol}USDT`);
        const p = parseFloat(ticker.data.last_price);
        if (p > t.highest) t.highest = p;

        const gain = ((p - t.entry) / t.entry) * 100;
        const drop = ((t.highest - p) / t.highest) * 100;
        const stopPercent = (t.stop / t.entry) * 100;

        // Profit Trailing
        const trail = gain > 1.0 ? 0.3 : 0.5;
        
        if ((gain > 0.7 && drop > trail) || gain < -(stopPercent + 0.2)) {
            const sold = await executeOrder("sell", t.symbol, 0, t.qty);
            if (sold) {
                activeTrades.splice(idx, 1);
                saveState();
            }
        }
    } catch (e) {}
}

cron.schedule('*/15 * * * * *', runScanner);
