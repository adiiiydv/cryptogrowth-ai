const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
let activeTrade = null; 

const signDCX = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

const runScalper = async () => {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1m&limit=50`);
        const prices = res.data.map(d => parseFloat(d[4]));
        
        const rsi = RSI.calculate({ values: prices, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: prices, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: prices, period: 21 }).pop();

        console.log(`📊 RSI: ${rsi.toFixed(2)} | EMA9: ${ema9.toFixed(2)} | EMA21: ${ema21.toFixed(2)}`);

        if (!activeTrade && rsi < 35 && ema9 > ema21) {
            console.log("🎯 Signal Found! Attempting Buy...");
            // Using 1.85 to leave buffer for 1% TDS
            const bought = await executeDCX("buy", 1.85); 
            if (bought) activeTrade = bought;
        }
    } catch (err) {
        console.log("⚠️ Scan Error:", err.message);
    }
};

async function executeDCX(side, amount) {
    try {
        const pRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT`);
        const price = parseFloat(pRes.data.price);
        const qty = (amount / price).toFixed(3);

        const body = { side, order_type: "market_order", market: "SOLUSDT", total_quantity: qty, timestamp: Date.now() };
        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        return { price, qty };
    } catch (err) {
        console.log(`❌ Order Failed: ${err.response?.data?.message || err.message}`);
        return null;
    }
}

cron.schedule('*/1 * * * *', runScalper);
app.listen(process.env.PORT || 3000);
