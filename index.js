const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const { RSI, EMA, ATR } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Apex Pro v7: Native DCX Engine ⚫ Live'));
app.listen(PORT, () => console.log(`✅ System Live | Port ${PORT}`));

// --- GLOBAL MEMORY & CONFIG ---
let WATCHLIST = ['DOGE', 'MATIC', 'ADA', 'XRP'];
let activeTrades = [];
let coinStats = {}; 
let lastTradePerCoin = {}; 
let higherTFCache = {};
let lastHTFFetch = 0;
let dailyKillSwitch = false;
const MAX_TRADES = 3;

let globalStats = { wins: 0, losses: 0, consecutiveLosses: 0, maxDrawdown: 0 };

const signDCX = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

const getPrecision = (symbol) => {
    const map = { 'DOGE': 4, 'XRP': 2, 'ADA': 2, 'MATIC': 2 };
    return map[symbol] || 2; 
};

// --- DAILY RESET CRON (00:00 AM) ---
cron.schedule('0 0 * * *', () => {
    dailyKillSwitch = false;
    globalStats.consecutiveLosses = 0;
    console.log("🔄 Daily reset: Performance cleared for new session.");
});

// --- CACHED 15M TREND CHECK ---
const getHigherTrendCached = async (symbol) => {
    const now = Date.now();
    if (!higherTFCache[symbol] || (now - lastHTFFetch > 60000)) {
        try {
            // Note: Using Binance here only for HTF trend as it's more stable for long candles
            const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=15m&limit=20`);
            const closes = res.data.map(d => parseFloat(d[4]));
            const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();
            higherTFCache[symbol] = ema9 > ema21;
            lastHTFFetch = now;
        } catch { higherTFCache[symbol] = false; }
    }
    return higherTFCache[symbol];
};

// --- EXECUTION ENGINE ---
async function executeOrder(side, symbol, amount, exactQty = null) {
    try {
        if (side === "buy" && amount < 4 && !exactQty) {
            console.log("❌ Amount too low for CoinDCX");
            return null;
        }

        const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${symbol}USDT`).catch(() => null);
        const safePrice = tickerRes?.data?.last_price ? parseFloat(tickerRes.data.last_price) : 0;
        if (!safePrice) return null;

        const precision = getPrecision(symbol);
        const qty = exactQty ? Number(exactQty.toFixed(precision)) : Number((amount / safePrice).toFixed(precision));

        if (!qty || qty <= 0) return null;

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

        console.log(`🚀 ${side.toUpperCase()} ${symbol} | QTY: ${qty} | PRICE: ${safePrice}`);
        return { price: safePrice, qty };
    } catch (e) {
        console.log(`❌ ${symbol} ERR:`, e.response?.data?.message || e.message);
        return null;
    }
}

// --- SCANNER (USING COINDCX DATA) ---
const runMultiScanner = async () => {
    if (dailyKillSwitch || globalStats.consecutiveLosses >= 3) return;

    for (let i = activeTrades.length - 1; i >= 0; i--) {
        await checkTrailingExit(activeTrades[i], i);
    }

    if (activeTrades.length >= MAX_TRADES) return;

    let balance = 0;
    try {
        const body = { timestamp: Date.now() };
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdt = bRes.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        if (usdt) balance = parseFloat(usdt.balance) - parseFloat(usdt.locked_balance || 0);
    } catch (e) {}

    for (const coin of WATCHLIST) {
        if (activeTrades.length >= MAX_TRADES || activeTrades.find(t => t.symbol === coin)) continue;
        if (Date.now() - (lastTradePerCoin[coin] || 0) < 90000) continue; // 90s cooldown

        try {
            // NATIVE COINDCX CANDLES
            const res = await axios.get(`https://public.coindcx.com/market_data/candles?pair=${coin}USDT&interval=1m`);
            const data = res.data.slice(0, 50); // Get recent 50
            const closes = data.map(d => parseFloat(d.close));
            const highs = data.map(d => parseFloat(d.high));
            const lows = data.map(d => parseFloat(d.low));

            const isHighTrendBull = await getHigherTrendCached(coin);
            
            const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
            const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();
            const currentAtr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop();

            let score = 0;
            if (rsi < 60) score++;
            if (ema9 > ema21) score++;
            if (isHighTrendBull) score += 2;
            
            // Momentum check
            if (closes[closes.length - 1] > closes[closes.length - 2]) score++;

            // 🎯 ACTIVITY TUNED: 3/5 if HighTrend is Bullish
            if (score >= 3 && isHighTrendBull && balance > 4) {
                const wr = coinStats[coin]?.winRate || 0.5;
                // PROBLEM 3 FIX: Balanced Allocation
                const tradeAmount = Math.min(
                    balance * (wr > 0.6 ? 0.35 : 0.25),
                    balance / 2
                ).toFixed(2);

                const bought = await executeOrder("buy", coin, tradeAmount);
                if (bought) {
                    activeTrades.push({ 
                        symbol: coin, 
                        entry: bought.price, 
                        qty: bought.qty, 
                        highestPrice: bought.price,
                        // ATR Stop Safety Fix
                        atrStop: Math.min(currentAtr * 1.5, bought.price * 0.01)
                    });
                    lastTradePerCoin[coin] = Date.now();
                }
            }
        } catch (e) {}
    }
};

// --- EXIT ENGINE ---
async function checkTrailingExit(trade, index) {
    try {
        const ticker = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${trade.symbol}USDT`);
        const price = parseFloat(ticker.data.last_price);
        if (price > trade.highestPrice) trade.highestPrice = price;

        const drop = ((trade.highestPrice - price) / trade.highestPrice) * 100;
        const gain = ((price - trade.entry) / trade.entry) * 100;

        const dynamicTrail = gain > 1.5 ? 0.25 : 0.4;
        const atrPercent = (trade.atrStop / trade.entry) * 100;

        if ((gain > 0.7 && drop > dynamicTrail) || gain < -atrPercent) {
            console.log(`🚪 EXITING ${trade.symbol} | Gain: ${gain.toFixed(2)}%`);
            
            if (gain > 0.15) {
                globalStats.wins++;
                globalStats.consecutiveLosses = 0;
            } else {
                globalStats.losses++;
                globalStats.consecutiveLosses++;
            }

            await executeOrder("sell", trade.symbol, 0, trade.qty);
            activeTrades.splice(index, 1);
        }
    } catch (e) {}
}

cron.schedule('*/15 * * * * *', runMultiScanner);
