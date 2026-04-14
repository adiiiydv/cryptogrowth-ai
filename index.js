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

// Load state on startup
if (fs.existsSync(STATE_FILE)) {
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { activeTrades = []; }
}
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
const safe = (v, p = 2) => v ? v.toFixed(p) : "0.00";

// --- BUG FIX: MARKET NAME MAPPER ---
// Converts Binance name (BTCUSDT) to CoinDCX Market ID (B-BTC_USDT)
const getCoinDCXMarket = (binanceSymbol) => {
    const coin = binanceSymbol.replace('USDT', '');
    return `B-${coin}_USDT`; 
};

// --- RELIABLE DATA SOURCE (BINANCE) ---
const getCandles = async (symbol) => {
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=50`;
        const res = await axios.get(url, { timeout: 5000 });
        return res.data.map(d => ({
            close: parseFloat(d[4]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3])
        }));
    } catch (e) { return []; }
};

const signDCX = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY)
    .update(Buffer.from(JSON.stringify(body)).toString()).digest('hex');

// --- FIXED EXECUTION ENGINE ---
async function executeOrder(side, binanceSymbol, amount, exactQty = null) {
    try {
        const marketId = getCoinDCXMarket(binanceSymbol);
        const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker`);
        const marketData = tickerRes.data.find(m => m.market === marketId);
        
        if (!marketData) {
            botLog(`❌ Market ID ${marketId} not found on CoinDCX.`);
            return null;
        }

        const price = parseFloat(marketData.last_price);
        // Precision fix for quantities
        const qty = exactQty ? Number(exactQty.toFixed(5)) : Number((amount / price).toFixed(5));
        
        if (qty <= 0) return null;

        const body = { 
            side, 
            order_type: "market_order", 
            market: marketId, 
            total_quantity: qty, 
            timestamp: Date.now() 
        };

        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 
                'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 
                'X-AUTH-SIGNATURE': signDCX(body) 
            }
        });

        return { price, qty };
    } catch (e) {
        botLog(`❌ Order Fail: ${e.response?.data?.message || e.message}`);
        return null;
    }
}

// --- EXIT STRATEGY (Trailing Stop & TP) ---
async function checkExits(t, idx) {
    try {
        const marketId = getCoinDCXMarket(t.symbol);
        const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker`);
        const marketData = tickerRes.data.find(m => m.market === marketId);
        if (!marketData) return;

        const p = parseFloat(marketData.last_price);
        if (p > t.highest) t.highest = p;

        const gain = ((p - t.entry) / t.entry) * 100;
        const dropFromHigh = ((t.highest - p) / t.highest) * 100;
        const stopPct = (t.stop / t.entry) * 100;

        // Exit Logic: Take Profit (Gain > 1.5% and slight drop) OR Stop Loss hit
        if ((gain > (1.2 + FEES) && dropFromHigh > 0.3) || gain < -stopPct) {
            const sold = await executeOrder("sell", t.symbol, 0, t.qty);
            if (sold) {
                lossStreak = (gain <= 0) ? lossStreak + 1 : 0;
                activeTrades.splice(idx, 1);
                saveState();
                botLog(`💰 SOLD ${t.symbol} | PnL: ${gain.toFixed(2)}% | Streak: ${lossStreak}`);
            }
        }
    } catch (e) { botLog(`⚠️ Exit Check Error: ${e.message}`); }
}

// --- MAIN SCANNER ---
const runScanner = async () => {
    if (new Date().getHours() !== lastHour) { tradesThisHour = 0; lastHour = new Date().getHours(); }
    if (lossStreak >= 5) return botLog("🛑 HALTED: Max Loss Streak reached.");

    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdt = (bRes.data || []).find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) - parseFloat(usdt.locked_balance || 0) : 0;
    } catch (e) { return botLog("⚠️ Balance API Error"); }

    botLog(`🔍 SCAN | Bal: $${lastKnownBal.toFixed(2)} | Quota: ${tradesThisHour}/${TARGET_TRADES_PER_HOUR}`);

    for (const coin of WATCHLIST) {
        const candles = await getCandles(coin);
        if (candles.length < 30) continue;

        const closes = candles.map(c => c.close);
        const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();
        const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
        const atr = ATR.calculate({ 
            high: candles.map(c => c.high), 
            low: candles.map(c => c.low), 
            close: closes, 
            period: 14 
        }).pop();

        const score = (rsi < 60 ? 1 : 0) + (ema9 > ema21 ? 1 : 0) + (closes.at(-1) > closes.at(-2) ? 1 : 0);
        botLog(`📊 ${coin.replace('USDT','').padEnd(5)} | RSI: ${safe(rsi)} | Score: ${score}/3`);

        // Entry Checks
        if (activeTrades.find(t => t.symbol === coin)) continue;
        if (Date.now() - (lastTradePerCoin[coin] || 0) < 60000) continue;

        if (score === 3 && tradesThisHour < TARGET_TRADES_PER_HOUR && lastKnownBal > 2.0) {
            const tradeAmt = (lastKnownBal * 0.40).toFixed(2); // Using 40% of balance for trade
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
                botLog(`🚀 SUCCESS: Bought ${coin} @ ${bought.price}`);
            }
        }
    }
    // Check for exits on active positions
    for (let i = activeTrades.length - 1; i >= 0; i--) { await checkExits(activeTrades[i], i); }
};

// --- ROUTES ---
app.get('/status', (req, res) => res.json({ activeTrades, balance: lastKnownBal, streak: lossStreak }));
app.get('/', (req, res) => res.send("Apex Pro Bot is active and scanning."));

app.listen(PORT, '0.0.0.0', () => {
    botLog(`✅ APEX PRO v12.4 ULTIMATE | PORT ${PORT}`);
    runScanner();
    cron.schedule('*/30 * * * * *', runScanner);
});
