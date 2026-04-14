const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const { RSI, EMA, ATR } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Apex Pro v6: Institutional Engine ⚫ Live'));
app.listen(PORT, () => console.log(`✅ System Live on Port ${PORT}`));

// --- GLOBAL CONFIG & MEMORY ---
let WATCHLIST = ['DOGE', 'MATIC', 'ADA', 'XRP'];
let activeTrades = [];
let coinStats = {}; 
let marketRegime = "neutral";
let dailyKillSwitch = false;
let lastTradeTime = 0;
const COOLDOWN = 60 * 1000;
const MAX_TRADES = 3;

let globalStats = {
    wins: 0,
    losses: 0,
    consecutiveLosses: 0,
    maxDrawdown: 0
};

const signDCX = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

// --- UTILITY: DYNAMIC PRECISION & TREND ---
const getPrecision = (symbol) => {
    const map = { 'DOGE': 4, 'XRP': 2, 'ADA': 2, 'MATIC': 2, 'TRX': 1 };
    return map[symbol] || 2; 
};

const checkHigherTrend = async (symbol) => {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=15m&limit=20`);
        const hCloses = res.data.map(d => parseFloat(d[4]));
        const hEma9 = EMA.calculate({ values: hCloses, period: 9 }).pop();
        const hEma21 = EMA.calculate({ values: hCloses, period: 21 }).pop();
        return hEma9 > hEma21;
    } catch (e) { return false; }
};

const detectMarketRegime = (closes) => {
    const short = closes.slice(-10);
    const long = closes.slice(-Math.min(50, closes.length));
    const shortChange = (short[short.length - 1] - short[0]) / short[0];
    const longChange = (long[long.length - 1] - long[0]) / long[0];
    const volatility = Math.abs(shortChange - longChange);

    if (shortChange > 0.005 && longChange > 0.01 && volatility < 0.03) return "bull";
    if (shortChange < -0.005 && longChange < -0.01 && volatility < 0.03) return "bear";
    return "sideways";
};

// --- EXECUTION ENGINE ---
async function executeOrder(side, symbol, amount, exactQty = null) {
    try {
        const pRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        const bPrice = parseFloat(pRes.data.price);
        const execPriceRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${symbol}USDT`).catch(() => null);
        const safePrice = execPriceRes?.data?.last_price ? parseFloat(execPriceRes.data.last_price) : bPrice;

        const precision = getPrecision(symbol);
        const qty = exactQty ? Number(exactQty.toFixed(precision)) : Number((amount / safePrice).toFixed(precision));

        if (!qty || qty <= 0 || (side === "buy" && amount < 4)) {
            console.log(`⚠️ ${symbol} | Execution blocked: QTY ${qty} / AMT ${amount}`);
            return null;
        }

        const body = {
            side,
            order_type: "market_order",
            market: `${symbol}USDT`,
            total_quantity: qty,
            timestamp: Date.now()
        };

        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });

        console.log(`🚀 ${side.toUpperCase()} ${symbol} | Qty: ${qty} | Price: ${safePrice}`);
        return { price: safePrice, qty };
    } catch (e) {
        console.log(`❌ ${symbol} ERR:`, e.response?.data?.message || e.message);
        return null;
    }
}

// --- SCANNER ---
const runMultiScanner = async () => {
    if (dailyKillSwitch || globalStats.consecutiveLosses >= 3) return;

    for (let i = activeTrades.length - 1; i >= 0; i--) {
        await checkTrailingExit(activeTrades[i], i);
    }

    if (activeTrades.length >= MAX_TRADES) return;

    let balance = 0;
    try {
        const body = { timestamp: Date.now() };
        const res = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdt = res.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        if (usdt) balance = parseFloat(usdt.balance) - parseFloat(usdt.locked_balance || 0);
    } catch (e) {}

    console.log(`\n--- 🔍 SCAN | BAL: ${balance.toFixed(2)} | CONSEC_L: ${globalStats.consecutiveLosses} ---`);

    for (const coin of WATCHLIST) {
        if (activeTrades.length >= MAX_TRADES || activeTrades.find(t => t.symbol === coin)) continue;

        try {
            const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=1m&limit=100`);
            const closes = res.data.map(d => parseFloat(d[4]));
            const isHighTrendBull = await checkHigherTrend(coin);
            
            marketRegime = detectMarketRegime(closes);
            const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
            const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();

            let score = 0;
            if (rsi < 60) score++;
            if (ema9 > ema21) score++;
            if (isHighTrendBull) score += 2; 
            if (marketRegime === "bull") score++;

            if (score >= 4 && isHighTrendBull && balance > 4) {
                const winRate = coinStats[coin]?.winRate || 0.5;
                const riskFactor = winRate > 0.6 ? 0.45 : 0.35;
                const tradeAmount = Math.min(balance - 0.1, balance * riskFactor).toFixed(2);

                const bought = await executeOrder("buy", coin, tradeAmount);
                if (bought) {
                    activeTrades.push({ symbol: coin, entry: bought.price, qty: bought.qty, highestPrice: bought.price });
                    lastTradeTime = Date.now();
                }
            }
        } catch (e) {}
    }
};

// --- EXIT LOGIC ---
async function checkTrailingExit(trade, index) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${trade.symbol}USDT`);
        const price = parseFloat(res.data.price);
        if (price > trade.highestPrice) trade.highestPrice = price;

        const drop = ((trade.highestPrice - price) / trade.highestPrice) * 100;
        const gain = ((price - trade.entry) / trade.entry) * 100;

        const dynamicTrail = gain > 1.5 ? 0.25 : 0.4;

        if ((gain > 0.7 && drop > dynamicTrail) || gain < -0.7) {
            console.log(`🚪 EXITING ${trade.symbol} | Gain: ${gain.toFixed(2)}%`);
            const isWin = gain > 0.15;
            
            if (isWin) {
                globalStats.wins++;
                globalStats.consecutiveLosses = 0;
            } else {
                globalStats.losses++;
                globalStats.consecutiveLosses++;
            }

            const portfolioPeak = Math.max(globalStats.wins + globalStats.losses, 1);
            const drawdown = (portfolioPeak - (globalStats.wins - globalStats.losses)) / portfolioPeak;
            globalStats.maxDrawdown = Math.max(globalStats.maxDrawdown, drawdown);

            await executeOrder("sell", trade.symbol, 0, trade.qty);
            activeTrades.splice(index, 1);
        }
    } catch (e) {}
}

cron.schedule('*/15 * * * * *', runMultiScanner);
