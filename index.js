const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// SERVER HEALTH
app.get('/', (req, res) => res.send('Apex Pro v2: Stable 🚀'));
app.listen(PORT, () => console.log(`✅ System Live on Port ${PORT}`));

// CONFIG
let WATCHLIST = ['SOL', 'BTC', 'ETH', 'DOGE', 'MATIC', 'ADA', 'XRP'];
let activeTrades = [];
const MAX_TRADES = 3;
let lastTradeTime = 0;
const COOLDOWN = 2 * 60 * 1000; 

// Helper for rate limits
const delay = ms => new Promise(res => setTimeout(res, ms));

const signDCX = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

// MAIN SCANNER
const runMultiScanner = async () => {
    // 1. Check existing trades (Safe loop for splicing)
    for (let i = activeTrades.length - 1; i >= 0; i--) {
        await checkTrailingExit(activeTrades[i], i);
    }

    if (activeTrades.length >= MAX_TRADES) return;

    const shuffledList = [...WATCHLIST].sort(() => Math.random() - 0.5);

    let balance = 4.01;
    try {
        const body = { timestamp: Date.now() };
        const balRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdtData = balRes.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        balance = usdtData ? parseFloat(usdtData.balance) : 4.01;
    } catch (e) { console.log("⚠️ Balance fetch failed"); }

    console.log(`\n--- 🔍 SCAN | Wallet: ${balance.toFixed(2)} USDT | Active: ${activeTrades.length} ---`);

    for (const coin of shuffledList) {
        if (activeTrades.length >= MAX_TRADES) break;
        if (activeTrades.find(t => t.symbol === coin)) continue;

        try {
            await delay(500); // Prevent API ban
            const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=1m&limit=100`);
            const prices = res.data.map(d => parseFloat(d[4]));
            const volumes = res.data.map(d => parseFloat(d[5]));

            const rsi = RSI.calculate({ values: prices, period: 14 }).pop();
            const ema9 = EMA.calculate({ values: prices, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: prices, period: 21 }).pop();
            const ema50 = EMA.calculate({ values: prices, period: 50 }).pop();

            const avgVolume = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
            const currentVolume = volumes[volumes.length - 1];
            const currentPrice = prices[prices.length - 1];

            console.log(`📊 ${coin.padEnd(5)} | RSI:${rsi.toFixed(1)} | Trend:${currentPrice > ema50 ? '📈' : '📉'} | Vol:${currentVolume > avgVolume ? '🔥' : '❄️'}`);

            if (rsi < 45 && ema9 >= ema21 && currentVolume > avgVolume && currentPrice > ema50 && (Date.now() - lastTradeTime > COOLDOWN)) {
                console.log(`🎯 BUY SIGNAL: ${coin}`);
                const tradeAmount = Math.max(2, (balance * 0.30)).toFixed(2); // Min 2 USDT for safety
                const bought = await executeOrder("buy", coin, tradeAmount);
                if (bought) {
                    activeTrades.push({ symbol: coin, entry: bought.price, qty: bought.qty, highestPrice: bought.price });
                    lastTradeTime = Date.now();
                }
            }
        } catch (e) { continue; }
    }
};

async function checkTrailingExit(trade, index) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${trade.symbol}USDT`);
        const currentPrice = parseFloat(res.data.price);
        if (currentPrice > trade.highestPrice) trade.highestPrice = currentPrice;

        const dropFromTop = ((trade.highestPrice - currentPrice) / trade.highestPrice) * 100;
        const totalGain = ((currentPrice - trade.entry) / trade.entry) * 100;

        console.log(`📈 ${trade.symbol} | Gain: ${totalGain.toFixed(2)}% | Peak: ${trade.highestPrice}`);

        if ((totalGain > 0.5 && dropFromTop > 0.25) || totalGain <= -0.7) {
            console.log(`🚪 SELL: ${trade.symbol}`);
            const sold = await executeOrder("sell", trade.symbol, (trade.qty * currentPrice).toFixed(2), trade.qty);
            if (sold) activeTrades.splice(index, 1);
        }
    } catch (e) { console.log(`❌ Exit failed: ${trade.symbol}`); }
}

async function executeOrder(side, symbol, amount, exactQty = null) {
    try {
        const pRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        const price = parseFloat(pRes.data.price);
        
        // Fix: Quantity must not have too many decimals for CoinDCX
        const qty = exactQty ? exactQty : (Math.floor((amount / price) * 100) / 100).toString();

        const body = { side, order_type: "market_order", market: `${symbol}USDT`, total_quantity: qty, timestamp: Date.now() };
        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        return { price, qty };
    } catch (err) {
        console.log(`❌ Order Failed: ${err.response?.data?.message || "API Error"}`);
        return null;
    }
}

cron.schedule('*/1 * * * *', runMultiScanner);
