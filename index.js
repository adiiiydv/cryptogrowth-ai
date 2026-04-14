const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs'); // For State Recovery
const { RSI, EMA, ATR } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- DYNAMIC CONFIG & WATCHLIST ---
const WATCHLIST = ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'MATIC', 'ADA', 'XRP']; // 8 Coins
const TRADE_LOG_FILE = './trade_journal.json';
const STATE_FILE = './bot_state.json';

let activeTrades = [];
let lastTradePerCoin = {};
let tradesThisHour = 0;
let dailyKillSwitch = false;
const MAX_TRADES = 4;
const FEES_SPREAD_ADJ = 0.25; // 0.25% buffer for fees/slippage

// --- STARTUP STATE RECOVERY ---
if (fs.existsSync(STATE_FILE)) {
    activeTrades = JSON.parse(fs.readFileSync(STATE_FILE));
    console.log(`🔄 RECOVERY: Resumed ${activeTrades.length} open positions.`);
}

const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));

// --- UTILITIES ---
const signDCX = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

const getPrecision = (s) => (['DOGE'].includes(s) ? 4 : ['BTC', 'ETH'].includes(s) ? 5 : 2);

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

// --- EXECUTION ENGINE (With Error Handling) ---
async function executeOrder(side, symbol, amount, exactQty = null) {
    try {
        if (side === "buy" && amount < 4 && !exactQty) return null;

        const ticker = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${symbol}USDT`);
        const price = parseFloat(ticker.data.last_price);
        const qty = exactQty ? Number(exactQty.toFixed(getPrecision(symbol))) : Number((amount / price).toFixed(getPrecision(symbol)));

        const body = { side, order_type: "market_order", market: `${symbol}USDT`, total_quantity: qty, timestamp: Date.now() };
        const res = await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });

        console.log(`🎯 ${side.toUpperCase()} CONFIRMED: ${symbol} @ ${price}`);
        return { price, qty };
    } catch (e) {
        console.log(`❌ ORDER REJECTED [${symbol}]:`, e.response?.data || e.message);
        return null;
    }
}

// --- SCANNER (High Frequency / 4 per hour intent) ---
const runScanner = async () => {
    if (dailyKillSwitch) return;

    // Maintenance: Check Exits
    for (let i = activeTrades.length - 1; i >= 0; i--) {
        await checkExits(activeTrades[i], i);
    }

    if (activeTrades.length >= MAX_TRADES) return;

    // Fetch Balance
    let balance = 0;
    try {
        const body = { timestamp: Date.now() };
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdt = bRes.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        if (usdt) balance = parseFloat(usdt.balance) - parseFloat(usdt.locked_balance || 0);
    } catch (e) { return; }

    for (const coin of WATCHLIST) {
        if (activeTrades.find(t => t.symbol === coin)) continue;
        if (Date.now() - (lastTradePerCoin[coin] || 0) < 60000) continue; // 1m per-coin cooldown

        const candles = await getCandles(coin, "1m");
        if (candles.length < 30) continue;

        const closes = candles.map(c => c.close);
        const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();
        const atr = ATR.calculate({ high: candles.map(c => c.high), low: candles.map(c => c.low), close: closes, period: 14 }).pop();

        let score = 0;
        const reason = [];

        if (rsi < 65) { score++; reason.push("RSI_OK"); }
        if (ema9 > ema21) { score++; reason.push("EMA_CROSS"); }
        if (closes[closes.length - 1] > closes[closes.length - 2]) { score++; reason.push("MOMENTUM"); }
        
        // 15m Trend is now a BONUS, not mandatory
        const hRes = await getCandles(coin, "15m");
        if (hRes.length > 20) {
            const hE9 = EMA.calculate({ values: hRes.map(c => c.close), period: 9 }).pop();
            const hE21 = EMA.calculate({ values: hRes.map(c => c.close), period: 21 }).pop();
            if (hE9 > hE21) { score += 2; reason.push("HTF_BULL"); }
        }

        // ENTRY: Score 3+ (High Frequency)
        if (score >= 3 && balance > 5) {
            const tradeAmt = (balance * 0.30).toFixed(2); // Risk 30% per trade
            const bought = await executeOrder("buy", coin, tradeAmt);
            if (bought) {
                activeTrades.push({
                    symbol: coin,
                    entry: bought.price,
                    qty: bought.qty,
                    highest: bought.price,
                    stop: atr * 1.5,
                    time: Date.now()
                });
                lastTradePerCoin[coin] = Date.now();
                tradesThisHour++;
                saveState();
                console.log(`✅ ENTRY ${coin} | Score: ${score} | Reasons: ${reason.join(",")}`);
            }
        }
    }
};

// --- DYNAMIC EXIT (Profit Lock & Fees) ---
async function checkExits(t, idx) {
    try {
        const ticker = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${t.symbol}USDT`);
        const p = parseFloat(ticker.data.last_price);
        if (p > t.highest) t.highest = p;

        const gain = ((p - t.entry) / t.entry) * 100;
        const drop = ((t.highest - p) / t.highest) * 100;
        const stopPercent = (t.stop / t.entry) * 100;

        // Profit Lock: If gain > 1%, don't let it turn into a loss
        const trail = gain > 1.2 ? 0.3 : 0.6;
        
        if ((gain > 0.8 && drop > trail) || gain < -(stopPercent + FEES_SPREAD_ADJ)) {
            const sold = await executeOrder("sell", t.symbol, 0, t.qty);
            if (sold) {
                const finalGain = gain - FEES_SPREAD_ADJ;
                console.log(`🚪 EXIT ${t.symbol} | Net Gain: ${finalGain.toFixed(2)}%`);
                // Journaling
                const log = `[${new Date().toISOString()}] ${t.symbol} | In: ${t.entry} | Out: ${p} | G: ${finalGain.toFixed(2)}%\n`;
                fs.appendFileSync(TRADE_LOG_FILE, log);
                activeTrades.splice(idx, 1);
                saveState();
            }
        }
    } catch (e) {}
}

// --- MONITORING (Web UI Alternative) ---
app.get('/status', (req, res) => {
    res.json({
        activeTrades,
        hourlyTrades: tradesThisHour,
        globalStats,
        uptime: process.uptime()
    });
});

cron.schedule('0 * * * *', () => { tradesThisHour = 0; }); // Reset hourly count
cron.schedule('*/15 * * * * *', runScanner);
