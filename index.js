const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 1. STABILITY: Render health check
app.get('/', (req, res) => res.send('Apex Multi-Trade: Active 🚀'));
app.listen(PORT, () => console.log(`✅ System Live on Port ${PORT}`));

// --- CONFIG ---
let WATCHLIST = ['SOL', 'BTC', 'ETH', 'DOGE', 'MATIC', 'ADA', 'XRP'];
let activeTrades = []; 

const signDCX = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

// 2. SCANNER WITH FULL LOGGING
const runMultiScanner = async () => {
    for (let i = activeTrades.length - 1; i >= 0; i--) {
        await checkTrailingExit(activeTrades[i], i);
    }

    const shuffledList = [...WATCHLIST].sort(() => Math.random() - 0.5);
    let balance = 4.01;
    try {
        const body = { timestamp: Date.now() };
        const balRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdtData = balRes.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        balance = usdtData ? parseFloat(usdtData.balance) : 4.01;
    } catch (e) { /* fallback to default balance */ }

    console.log(`\n--- 🔍 SCANNING WATCHLIST | Wallet: ${balance.toFixed(2)} USDT ---`);

    for (const coin of shuffledList) {
        if (activeTrades.find(t => t.symbol === coin)) continue;

        try {
            const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=1m&limit=50`);
            const prices = res.data.map(d => parseFloat(d[4]));
            const volumes = res.data.map(d => parseFloat(d[5]));

            const rsi = RSI.calculate({ values: prices, period: 14 }).pop();
            const ema9 = EMA.calculate({ values: prices, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: prices, period: 21 }).pop();
            const avgVolume = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
            const currentVolume = volumes[volumes.length - 1];

            // DETAILED LOGGING FOR YOU TO SEE
            console.log(`📊 [${coin}] P: ${prices[prices.length-1]} | RSI: ${rsi.toFixed(2)} | EMA9: ${ema9.toFixed(2)} | Vol: ${currentVolume > avgVolume ? '🔥' : '❄️'}`);

            if (rsi < 45 && ema9 >= ema21 && currentVolume > avgVolume) {
                console.log(`🎯 SIGNAL DETECTED: ${coin}`);
                const tradeAmount = (balance * 0.60).toFixed(2);
                const bought = await executeOrder("buy", coin, tradeAmount);
                if (bought) {
                    activeTrades.push({ symbol: coin, entry: bought.price, qty: bought.qty, highestPrice: bought.price });
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

        console.log(`📈 HOLDING ${trade.symbol} | Gain: ${totalGain.toFixed(2)}% | High: ${trade.highestPrice}`);

        if ((totalGain > 0.7 && dropFromTop > 0.3) || totalGain <= -0.8) {
            console.log(`🚪 EXITING ${trade.symbol}`);
            const sold = await executeOrder("sell", trade.symbol, (trade.qty * currentPrice).toFixed(2));
            if (sold) activeTrades.splice(index, 1);
        }
    } catch (e) { console.log(`Exit check failed for ${trade.symbol}`); }
}

async function executeOrder(side, symbol, amount) {
    try {
        const pRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        const price = parseFloat(pRes.data.price);
        const qty = (amount / price).toFixed(3);
        const body = { side, order_type: "market_order", market: `${symbol}USDT`, total_quantity: qty, timestamp: Date.now() };
        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        return { price, qty };
    } catch (err) {
        console.log(`❌ Order Failed: ${err.response?.data?.message || "Check API"}`);
        return null;
    }
}

cron.schedule('*/1 * * * *', runMultiScanner);
