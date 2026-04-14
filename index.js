const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA, ATR } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. RENDER PORT BINDING & MONITORING ---
// This prevents the "No open ports detected" and "Application exited early" errors
app.get('/', (req, res) => res.json({ status: "Online", active: activeTrades.length }));
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ SERVER LIVE: Listening on port ${PORT}`);
});

// --- 2. GLOBAL CONFIG & WATCHLIST ---
const WATCHLIST = ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'MATIC', 'ADA', 'XRP'];
const STATE_FILE = './bot_state.json';
let activeTrades = [];
let lastTradePerCoin = {};
let lastKnownBal = 0;

// Institutional Precision Map: Fixes "DOGE precision should be 4" (Code 400)
const getPrecision = (symbol) => {
    const map = { 
        'DOGE': 4, 
        'BTC': 5, 
        'ETH': 5, 
        'XRP': 2, 
        'ADA': 2, 
        'MATIC': 2, 
        'SOL': 2, 
        'BNB': 2 
    };
    return map[symbol] || 2;
};

// --- 3. STATE RECOVERY ---
// Saves trades to a file so they aren't lost when Render restarts
if (fs.existsSync(STATE_FILE)) {
    try {
        activeTrades = JSON.parse(fs.readFileSync(STATE_FILE));
        console.log(`🔄 RECOVERY: Loaded ${activeTrades.length} open positions.`);
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
        if (!Array.isArray(res.data)) return [];
        return res.data.map(d => ({
            close: parseFloat(d.close),
            high: parseFloat(d.high),
            low: parseFloat(d.low)
        })).reverse(); // DCX returns newest first; reverse for indicators
    } catch { return []; }
};

// --- 5. EXECUTION ENGINE (Precision & Error Fixed) ---
async function executeOrder(side, symbol, amount, exactQty = null) {
    try {
        if (side === "buy" && amount < 4 && !exactQty) return null;

        const ticker = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${symbol}USDT`);
        const price = parseFloat(ticker.data.last_price);
        
        // APPLY PRECISION FIX
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

// --- 6. SCANNER LOGIC ---
const runScanner = async () => {
    // Maintenance: Check current open positions for exit
    for (let i = activeTrades.length - 1; i >= 0; i--) {
        await checkExits(activeTrades[i], i);
    }

    if (activeTrades.length >= 4) return; // Max concurrent trades

    // Fetch USDT Balance
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
        if (Date.now() - (lastTradePerCoin[coin] || 0) < 90000) continue; // 90s Cooldown

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

        // ENTRY: 2/3 Score for higher trade frequency
        if (score >= 3 && lastKnownBal > 5) {
            const tradeAmt = Math.min(lastKnownBal * 0.35, lastKnownBal - 0.1).toFixed(2);
            const bought = await executeOrder("buy", coin, tradeAmt);
            if (bought) {
                activeTrades.push({
                    symbol: coin,
                    entry: bought.price,
                    qty: bought.qty,
                    highest: bought.price,
                    stop: Math.min(atr * 1.5, bought.price * 0.015) 
                });
                lastTradePerCoin[coin] = Date.now();
                saveState();
            }
        }
    }
};

// --- 7. EXIT STRATEGY (Trailing Stop & ATR) ---
async function checkExits(t, idx) {
    try {
        const ticker = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${t.symbol}USDT`);
        const p = parseFloat(ticker.data.last_price);
        if (p > t.highest) t.highest = p;

        const gain = ((p - t.entry) / t.entry) * 100;
        const drop = ((t.highest - p) / t.highest) * 100;
        const stopPercent = (t.stop / t.entry) * 100;

        // Dynamic Profit Trailing (Tighter once gain > 1%)
        const trail = gain > 1.0 ? 0.35 : 0.6;
        
        if ((gain > 0.8 && drop > trail) || gain < -(stopPercent + 0.25)) {
            const sold = await executeOrder("sell", t.symbol, 0, t.qty);
            if (sold) {
                activeTrades.splice(idx, 1);
                saveState();
            }
        }
    } catch (e) {}
}

// RUN SCANNER EVERY 15 SECONDS
cron.schedule('*/15 * * * * *', runScanner);
