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

const TARGET_TRADES_PER_HOUR = 4;
let tradesThisHour = 0;
let lastHour = new Date().getHours();

let activeTrades = [];
let tradeHistory = []; 
let lastTradePerCoin = {}; 
let lastKnownBal = 0;
let lossStreak = 0;
let dailyLoss = 0; 

let stats = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    totalProfit: 0,
    totalLoss: 0
};

app.use(express.static('public'));

const botLog = (msg) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${msg}`);
};

// Load state safely
if (fs.existsSync(STATE_FILE)) {
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { activeTrades = []; }
}
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
const getPrecision = (s) => ({ 'DOGE': 4, 'BTC': 5, 'ETH': 5 }[s] || 2);
const safe = (v, p = 4) => v ? v.toFixed(p) : "N/A";

const getPerformance = () => {
    const winRate = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades) * 100 : 0;
    const avgWin = stats.wins > 0 ? stats.totalProfit / stats.wins : 0;
    const avgLoss = stats.losses > 0 ? stats.totalLoss / stats.losses : 0;
    const netPnL = stats.totalProfit - stats.totalLoss;
    const profitFactor = stats.totalLoss > 0 ? stats.totalProfit / stats.totalLoss : 0;

    return {
        totalTrades: stats.totalTrades,
        winRate: winRate.toFixed(2),
        avgWin: avgWin.toFixed(2),
        avgLoss: avgLoss.toFixed(2),
        netPnL: netPnL.toFixed(2),
        profitFactor: profitFactor.toFixed(2)
    };
};

// --- DASHBOARD API ---
app.get('/status', (req, res) => res.json({ 
    status: lossStreak >= 5 ? "HALTED" : "ACTIVE", 
    activeTrades, 
    balance: lastKnownBal, 
    streak: lossStreak,
    dailyLoss: dailyLoss.toFixed(2),
    tradesThisHour,
    performance: getPerformance()
}));

// --- CORE UTILS ---
const signDCX = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY)
    .update(Buffer.from(JSON.stringify(body)).toString()).digest('hex');

const getCandles = async (symbol) => {
    try {
        const res = await axios.get(`https://public.coindcx.com/market_data/candles?pair=${symbol}USDT&interval=1m`);
        return Array.isArray(res.data) ? res.data.map(d => ({ 
            close: parseFloat(d.close), high: parseFloat(d.high), low: parseFloat(d.low) 
        })).reverse() : [];
    } catch { return []; }
};

// --- EXECUTION ENGINE ---
async function executeOrder(side, symbol, amount, exactQty = null) {
    try {
        if (side === "buy" && amount < 1.0) return null;
        const ticker = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${symbol}USDT`);
        let price = parseFloat(ticker.data.last_price);
        const bufferedPrice = side === "buy" ? price * 1.001 : price * 0.999;
        const qty = exactQty ? Number(exactQty.toFixed(getPrecision(symbol))) : Number((amount / bufferedPrice).toFixed(getPrecision(symbol)));
        
        if (!qty || qty <= 0) return null;

        const body = { side, order_type: "market_order", market: `${symbol}USDT`, total_quantity: qty, timestamp: Date.now() };
        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        return { price: price, qty };
    } catch (e) {
        botLog(`❌ Order Error: ${e.response?.data?.message || e.message}`);
        return null;
    }
}

// --- MAIN SCANNER (COMBINED & CORRECTED) ---
const runScanner = async () => {
    const currentHour = new Date().getHours();
    if (currentHour !== lastHour) { tradesThisHour = 0; lastHour = currentHour; }

    if (lossStreak >= 5) return botLog("🛑 HALTED: Streak at 5");

    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdt = bRes.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) - parseFloat(usdt.locked_balance || 0) : 0;
    } catch (e) { return botLog("⚠️ Balance API Error"); }

    botLog(`🔍 SCAN START | Bal: $${lastKnownBal.toFixed(2)} | Quota: ${tradesThisHour}/${TARGET_TRADES_PER_HOUR}`);

    let marketIsBullish = true;
    const btcCandles = await getCandles('BTC');
    if (btcCandles.length > 21) {
        const btcCloses = btcCandles.map(c => c.close);
        marketIsBullish = btcCloses.at(-1) > EMA.calculate({ values: btcCloses, period: 21 }).pop();
    }

    for (const coin of WATCHLIST) {
        try {
            const candles = await getCandles(coin);
            
            if (!candles || candles.length < 30) {
                botLog(`📡 ${coin.padEnd(5)} | ⚠️ Waiting for data (${candles?.length || 0}/30)`);
                continue;
            }

            const closes = candles.map(c => c.close);
            const high = candles.map(c => c.high);
            const low = candles.map(c => c.low);

            const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();
            const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
            const atr = ATR.calculate({ high, low, close: closes, period: 14 }).pop();

            const isBull = ema9 > ema21;
            const volatility = (atr / closes.at(-1)) * 100;
            const score = (rsi < 60 ? 1 : 0) + (isBull ? 1 : 0) + (closes.at(-1) > closes.at(-2) ? 1 : 0) + (volatility > 0.1 ? 1 : 0);

            // Visibility Log
            botLog(`📊 ${coin.padEnd(5)} | RSI: ${safe(rsi, 1)} | Score: ${score}/4 | ${isBull ? "🟢" : "🔴"}`);

            // Safety Filters
            if (activeTrades.find(t => t.symbol === coin)) continue;
            if (Date.now() - (lastTradePerCoin[coin] || 0) < 60000) continue; 
            
            if (score < 3) continue; 

            // Entry Logic (50% risk for CoinDCX minimums)
            if (tradesThisHour < TARGET_TRADES_PER_HOUR && activeTrades.length < 4 && lastKnownBal > 2.0) {
                const tradeAmt = (lastKnownBal * 0.50).toFixed(2); 
                const bought = await executeOrder("buy", coin, tradeAmt);
                if (bought) {
                    activeTrades.push({ 
                        symbol: coin, entry: bought.price, qty: bought.qty, highest: bought.price, 
                        stop: atr ? atr * 1.5 : bought.price * 0.015 
                    });
                    lastTradePerCoin[coin] = Date.now();
                    tradesThisHour++;
                    saveState();
                    botLog(`🚀 SUCCESS: BOUGHT ${coin} @ ${bought.price}`);
                }
            }
        } catch (err) {
            botLog(`❌ Loop Error [${coin}]: ${err.message}`);
        }
    }
    for (let i = activeTrades.length - 1; i >= 0; i--) { await checkExits(activeTrades[i], i); }
};

async function checkExits(t, idx) {
    try {
        const ticker = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${t.symbol}USDT`);
        const p = parseFloat(ticker.data.last_price);
        if (p > t.highest) t.highest = p;

        const gain = ((p - t.entry) / t.entry) * 100;
        const drop = ((t.highest - p) / t.highest) * 100;
        const stopPct = (t.stop / t.entry) * 100;

        if ((gain > (1.2 + FEES) && drop > 0.3) || gain < -stopPct) {
            const sold = await executeOrder("sell", t.symbol, 0, t.qty);
            if (sold) {
                stats.totalTrades++;
                if (gain > 0) { stats.wins++; stats.totalProfit += gain; } 
                else { stats.losses++; stats.totalLoss += Math.abs(gain); dailyLoss += Math.abs((p - t.entry) * t.qty); }
                
                lossStreak = (gain <= 0) ? lossStreak + 1 : 0;
                activeTrades.splice(idx, 1);
                saveState();
                botLog(`💰 SOLD ${t.symbol} | PnL: ${gain.toFixed(2)}% | Streak: ${lossStreak}`);
            }
        }
    } catch (e) {}
}

app.listen(PORT, '0.0.0.0', () => {
    botLog(`✅ APEX PRO v12.0 CONSOLIDATED | PORT ${PORT}`);
    runScanner();
    cron.schedule('*/30 * * * * *', runScanner);
});
