const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const { RSI, EMA, ATR } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Apex Pro v5: Self-Learning Optimizer 🚀'));
app.listen(PORT, () => console.log(`✅ Optimizer System Live | Port ${PORT}`));

// CONFIG & INSTITUTIONAL MEMORY
let WATCHLIST = ['DOGE', 'MATIC', 'ADA', 'XRP'];
let activeTrades = [];
let coinStats = {}; 
let marketRegime = "neutral";
let dailyKillSwitch = false;

// NEW: GLOBAL PERFORMANCE TRACKING
let globalStats = {
    wins: 0,
    losses: 0,
    consecutiveLosses: 0,
    maxDrawdown: 0
};

const MAX_TRADES = 3;
let lastTradeTime = 0;
const COOLDOWN = 60 * 1000;

const signDCX = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

// IMPROVED REGIME LOGIC (Volatility Filtered)
const detectMarketRegime = (closes) => {
    const short = closes.slice(-10);
    const long = closes.slice(-Math.min(50, closes.length));
    
    const shortChange = (short[short.length - 1] - short[0]) / short[0];
    const longChange = (long[long.length - 1] - long[0]) / long[0];
    const volatility = Math.abs(shortChange - longChange);

    if (shortChange > 0.008 && longChange > 0.015 && volatility < 0.02) return "bull";
    if (shortChange < -0.008 && longChange < -0.015 && volatility < 0.02) return "bear";
    return "sideways";
};

// ================= SCANNER =================
const runMultiScanner = async () => {
    if (dailyKillSwitch) return;
    
    // NEW: Consecutive Loss Kill Switch
    if (globalStats.consecutiveLosses >= 3) {
        console.log("🛑 RISK ENGINE STOP: 3 consecutive losses");
        dailyKillSwitch = true;
        return;
    }

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

    const shuffled = [...WATCHLIST].sort(() => Math.random() - 0.5);

    for (const coin of shuffled) {
        if (activeTrades.length >= MAX_TRADES) break;
        if (activeTrades.find(t => t.symbol === coin)) continue;

        try {
            const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=1m&limit=100`);
            const closes = res.data.map(d => parseFloat(d[4]));
            const highs = res.data.map(d => parseFloat(d[2]));
            const lows  = res.data.map(d => parseFloat(d[3]));
            const volumes = res.data.map(d => parseFloat(d[5]));

            marketRegime = detectMarketRegime(closes);
            const stats = coinStats[coin] || { winRate: 0.5, drawdown: 0 };

            const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
            const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();
            const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop();

            const currentPrice = closes[closes.length - 1];
            const avgVol = volumes.slice(-20).reduce((a,b)=>a+b,0)/20;
            const volSpike = volumes[volumes.length - 1] > avgVol * 1.1;
            const trendStrength = (ema9 - ema21) / ema21;
            const volatilityOk = atr && atr > currentPrice * 0.0015;

            let score = 0;
            if (rsi < 55) score++;
            if (ema9 > ema21) score++;
            if (trendStrength > 0) score++;
            if (volSpike) score++;
            if (volatilityOk) score++;
            if (Date.now() - lastTradeTime > COOLDOWN) score++;
            if (marketRegime === "bull") score++;
            if (stats.winRate > 0.55) score++;
            if (marketRegime === "sideways") score--;

            if (score >= 6 && balance > 4 && stats.drawdown < 5) {
                const riskFactor = stats.winRate > 0.6 ? 0.45 : 0.30;
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

// ================= EXIT & PERFORMANCE LOGIC =================
async function checkTrailingExit(trade, index) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${trade.symbol}USDT`);
        const price = parseFloat(res.data.price);
        if (price > trade.highestPrice) trade.highestPrice = price;

        const drop = ((trade.highestPrice - price) / trade.highestPrice) * 100;
        const gain = ((price - trade.entry) / trade.entry) * 100;

        if ((gain > 0.8 && drop > 0.3) || gain < -0.6) {
            console.log(`🚪 EXIT ${trade.symbol}`);

            // UPGRADED WIN LOGIC (Strict Win: > 0.15%)
            const isWin = gain > 0.15;
            if (isWin) {
                globalStats.wins++;
                globalStats.consecutiveLosses = 0;
            } else {
                globalStats.losses++;
                globalStats.consecutiveLosses++;
            }

            // PORTFOLIO DRAWDOWN TRACKING
            const portfolioPeak = Math.max(globalStats.wins + globalStats.losses, 1);
            const currentEquity = globalStats.wins - globalStats.losses;
            const drawdown = (portfolioPeak - currentEquity) / portfolioPeak;
            globalStats.maxDrawdown = Math.max(globalStats.maxDrawdown, drawdown);

            // COIN SPECIFIC STATS
            if (!coinStats[trade.symbol]) coinStats[trade.symbol] = { winRate: 0.5, drawdown: 0 };
            coinStats[trade.symbol].winRate = (coinStats[trade.symbol].winRate * 0.9) + (isWin ? 0.1 : -0.1);

            const body = {
                side: "sell",
                order_type: "market_order",
                market: `${trade.symbol}USDT`,
                total_quantity: Number(trade.qty.toFixed(5)),
                timestamp: Date.now()
            };

            await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
                headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
            });

            activeTrades.splice(index, 1);
        }
    } catch (e) {}
}

// ================= EXECUTION SYNC =================
async function executeOrder(side, symbol, amount) {
    try {
        const pRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        const price = parseFloat(pRes.data.price);

        // SYNC: Fetch actual last price from CoinDCX for high-accuracy quantity
        const execPriceRes = await axios.get(
            `https://api.coindcx.com/exchange/v1/markets/ticker?pair=${symbol}USDT`
        ).catch(() => null);

        const execPrice = execPriceRes?.data?.last_price
            ? parseFloat(execPriceRes.data.last_price)
            : price;

        const safePrice = execPrice || price;
        const qty = Number((amount / safePrice).toFixed(5));

        const body = {
            side,
            order_type: "market_order",
            market: `${symbol}USDT`,
            total_quantity: qty,
            timestamp: Date.now()
        };

        console.log(`📤 ${side.toUpperCase()} ${symbol} | PRICE SYNC: ${safePrice.toFixed(4)}`);

        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });

        return { price: safePrice, qty };
    } catch (e) {
        console.log("❌ ORDER ERROR", e.response?.data || e.message);
        return null;
    }
}

cron.schedule('*/15 * * * * *', runMultiScanner);
