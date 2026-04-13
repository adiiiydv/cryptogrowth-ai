const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 1. STABILITY: Signal "Live" to Render immediately
app.get('/', (req, res) => res.send('Apex Pro: Active 🚀'));
app.listen(PORT, () => console.log(`✅ System Live on Port ${PORT}`));

// --- CONFIG ---
let WATCHLIST = ['SOL', 'BTC', 'ETH', 'DOGE', 'MATIC', 'ADA', 'XRP'];
let activeTrade = null;

const signDCX = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

// 2. APEX PRO SCANNER (Compounding + Bias Removal)
const runMultiScanner = async () => {
    if (activeTrade) {
        await checkTrailingExit(activeTrade);
        return;
    }

    const shuffledList = [...WATCHLIST].sort(() => Math.random() - 0.5);
    let balance = 4.01; 

    try {
        const body = { timestamp: Date.now() };
        const balRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) },
            timeout: 5000
        });
        const usdtData = balRes.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        balance = usdtData ? parseFloat(usdtData.balance) : 4.01;
    } catch (e) { console.log("Balance fetch failed, using fallback."); }

    console.log(`--- 🔍 SCAN | Wallet: ${balance.toFixed(2)} USDT | ${new Date().toLocaleTimeString()} ---`);

    for (const coin of shuffledList) {
        try {
            const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=1m&limit=50`, { timeout: 5000 });
            const prices = res.data.map(d => parseFloat(d[4]));
            const rsi = RSI.calculate({ values: prices, period: 14 }).pop();
            const ema9 = EMA.calculate({ values: prices, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: prices, period: 21 }).pop();

            if (rsi < 35 && ema9 > ema21) {
                const tradeAmount = (balance * 0.95).toFixed(2);
                const bought = await executeOrder("buy", coin, tradeAmount);
                if (bought) {
                    activeTrade = { symbol: coin, entry: bought.price, qty: bought.qty, highestPrice: bought.price };
                    break;
                }
            }
        } catch (e) { continue; }
    }
};

// 3. TRAILING PROFIT LOGIC
async function checkTrailingExit(trade) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${trade.symbol}USDT`, { timeout: 5000 });
        const currentPrice = parseFloat(res.data.price);
        if (currentPrice > trade.highestPrice) trade.highestPrice = currentPrice;

        const dropFromTop = ((trade.highestPrice - currentPrice) / trade.highestPrice) * 100;
        const totalGain = ((currentPrice - trade.entry) / trade.entry) * 100;

        if ((totalGain > 1.5 && dropFromTop > 0.5) || totalGain <= -1.2) {
            const sold = await executeOrder("sell", trade.symbol, (trade.qty * currentPrice).toFixed(2));
            if (sold) activeTrade = null;
        }
    } catch (e) { console.log("Exit check failed."); }
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
        console.log(`❌ Order Failed: ${err.response?.data?.message || "Check API Key Spot Permissions"}`);
        return null;
    }
}

cron.schedule('*/1 * * * *', runMultiScanner);
