const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA, ATR } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIG & GLOBAL STATE ---
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

// Persistence
if (fs.existsSync(STATE_FILE)) {
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { activeTrades = []; }
}
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
const safe = (v, p = 2) => (v ? v.toFixed(p) : "0.00");

// --- UTILS: SIGNING & DATA ---
const signDCX = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY)
    .update(Buffer.from(JSON.stringify(body)).toString()).digest('hex');

const getCandles = async (symbol) => {
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=50`;
        const res = await axios.get(url, { timeout: 5000 });
        return res.data.map(d => ({ close: parseFloat(d[4]), high: parseFloat(d[2]), low: parseFloat(d[3]) }));
    } catch (e) { return []; }
};

// --- CORE: SMART EXECUTION ENGINE ---
async function executeOrder(side, binanceSymbol, amount, exactQty = null) {
    try {
        // Step 1: Resolve exact market ID and precision
        const marketsRes = await axios.get('https://api.coindcx.com/exchange/v1/markets_details');
        const coin = binanceSymbol.replace('USDT', '');
        const possibleIds = [binanceSymbol, `B-${coin}_USDT`, `${coin}_USDT` ];
        
        const mInfo = marketsRes.data.find(m => possibleIds.includes(m.symbol) || possibleIds.includes(m.coindcx_name));
        if (!mInfo) throw new Error(`Market not found for ${binanceSymbol}`);

        const marketId = mInfo.symbol;
        const prec = mInfo.target_currency_precision || 5;

        // Step 2: Get Live Price
        const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker`);
        const ticker = tickerRes.data.find(t => t.market === marketId);
        const price = parseFloat(ticker.last_price);

        // Step 3: Calculate Quantity
        const qty = exactQty ? Number(exactQty.toFixed(prec)) : Number((amount / price).toFixed(prec));
        if (qty <= 0) return null;

        const body = { 
            side, 
            order_type: "market_order", 
            market: marketId, 
            total_quantity: qty, 
            timestamp: Date.now() 
        };

        const res = await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });

        return { price, qty, marketId };
    } catch (e) {
        botLog(`❌ ${side.toUpperCase()} FAIL | ${binanceSymbol}: ${e.response?.data?.message || e.message}`);
        return null;
    }
}

// --- EXIT STRATEGY (CHECKER) ---
async function checkExits(t, idx, tickerList) {
    try {
        const coin = t.symbol.replace('USDT', '');
        const possibleIds = [t.symbol, `B-${coin}_USDT`, `${coin}_USDT` ];
        const marketData = tickerList.find(m => possibleIds.includes(m.market));
        
        if (!marketData) return;
        const p = parseFloat(marketData.last_price);
        
        if (p > t.highest) t.highest = p;
        const gain = ((p - t.entry) / t.entry) * 100;
        const dropFromHigh = ((t.highest - p) / t.highest) * 100;
        const stopLossVal = (t.stop / t.entry) * 100;

        // 🟢 Take Profit: 1.2% gain + 0.3% pullback | 🔴 Stop Loss: ATR based
        if ((gain > (1.2 + FEES) && dropFromHigh > 0.3) || gain < -stopLossVal) {
            const sold = await executeOrder("sell", t.symbol, 0, t.qty);
            if (sold) {
                lossStreak = (gain <= 0) ? lossStreak + 1 : 0;
                activeTrades.splice(idx, 1);
                saveState();
                botLog(`💰 EXIT ${t.symbol} | PnL: ${gain.toFixed(2)}% | Streak: ${lossStreak}`);
            }
        }
    } catch (e) { botLog(`⚠️ Exit Error: ${e.message}`); }
}

// --- SCANNER LOOP ---
const runScanner = async () => {
    if (new Date().getHours() !== lastHour) { tradesThisHour = 0; lastHour = new Date().getHours(); }
    if (lossStreak >= 5) return botLog("🛑 HALTED: Max Loss Streak reached.");

    // Update Balance
    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdt = (bRes.data || []).find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) - parseFloat(usdt.locked_balance || 0) : 0;
    } catch (e) { return botLog("⚠️ Bal API Err"); }

    const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker`);
    const allTickers = tickerRes.data;

    botLog(`🔍 SCAN | Bal: $${lastKnownBal.toFixed(2)} | Quota: ${tradesThisHour}/${TARGET_TRADES_PER_HOUR}`);

    // Check Exits first
    for (let i = activeTrades.length - 1; i >= 0; i--) {
        await checkExits(activeTrades[i], i, allTickers);
    }

    // Scan for entries
    for (const coin of WATCHLIST) {
        if (activeTrades.find(t => t.symbol === coin)) continue;
        if (Date.now() - (lastTradePerCoin[coin] || 0) < 60000) continue;

        const candles = await getCandles(coin);
        if (candles.length < 30) continue;

        const closes = candles.map(c => c.close);
        const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();
        const atr = ATR.calculate({ high: candles.map(c=>c.high), low: candles.map(c=>c.low), close: closes, period: 14 }).pop();

        const score = (rsi < 60 ? 1 : 0) + (ema9 > ema21 ? 1 : 0) + (closes.at(-1) > closes.at(-2) ? 1 : 0);
        
        if (score === 3 && tradesThisHour < TARGET_TRADES_PER_HOUR && lastKnownBal > 5.0) {
            const tradeAmt = (lastKnownBal * 0.40).toFixed(2); 
            const bought = await executeOrder("buy", coin, tradeAmt);
            if (bought) {
                activeTrades.push({ 
                    symbol: coin, 
                    entry: bought.price, 
                    qty: bought.qty, 
                    highest: bought.price, 
                    stop: atr ? atr * 1.5 : bought.price * 0.015 
                });
                lastTradePerCoin[coin] = Date.now();
                tradesThisHour++;
                saveState();
                botLog(`🚀 ENTRY SUCCESS: ${coin} @ ${bought.price}`);
            }
        }
    }
};

// --- APP SETUP ---
app.get('/status', (req, res) => res.json({ balance: lastKnownBal, trades: activeTrades, lossStreak }));
app.get('/', (req, res) => res.send("Apex Pro v12.6 is Live."));

app.listen(PORT, '0.0.0.0', () => {
    botLog(`✅ APEX PRO v12.6 ULTIMATE | PORT ${PORT}`);
    runScanner();
    cron.schedule('*/30 * * * * *', runScanner);
});
