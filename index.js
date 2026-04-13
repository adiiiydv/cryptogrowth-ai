const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// 1. IMMEDIATE RENDER SIGNAL (Fixes "Exited Early" Error)
app.get('/', (req, res) => res.send('Bot is Live 🚀'));
app.listen(PORT, () => console.log(`✅ Render Health Check Passed on Port ${PORT}`));

const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

// --- CONFIG ---
let WATCHLIST = ['SOL', 'BTC', 'ETH', 'DOGE', 'MATIC', 'ADA', 'XRP'];
let activeTrade = null;

const signDCX = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

// 2. AGGRESSIVE BUYER LOGIC
const runMultiScanner = async () => {
    if (activeTrade) {
        await checkExit(activeTrade);
        return;
    }

    console.log(`--- 🚀 HUNTING | Wallet: 4.01 USDT | ${new Date().toLocaleTimeString()} ---`);

    for (const coin of WATCHLIST) {
        try {
            const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=1m&limit=50`, { timeout: 4000 });
            const prices = res.data.map(d => parseFloat(d[4]));
            
            const rsi = RSI.calculate({ values: prices, period: 14 }).pop();
            const currentPrice = prices[prices.length - 1];

            console.log(`📡 [${coin}] RSI: ${rsi.toFixed(2)} | Price: ${currentPrice}`);

            // AGGRESSIVE: Buy immediately if RSI is below 32
            if (rsi < 32) {
                console.log(`🎯 TARGET LOCKED: Buying ${coin}...`);
                const bought = await executeOrder("buy", coin, 3.1); // Using 3.1 USDT to be safe above minimum
                if (bought) {
                    activeTrade = { symbol: coin, entry: bought.price, qty: bought.qty };
                    break;
                }
            }
        } catch (e) { continue; }
    }
};

async function executeOrder(side, symbol, amount) {
    try {
        const pRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        const price = parseFloat(pRes.data.price);
        const qty = (amount / price).toFixed(3);
        const body = { side, order_type: "market_order", market: `${symbol}USDT`, total_quantity: qty, timestamp: Date.now() };
        
        const response = await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        return { price, qty };
    } catch (err) {
        console.log(`❌ Order Failed: ${err.response?.data?.message || "Check API Key Spot Permissions"}`);
        return null;
    }
}

async function checkExit(trade) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${trade.symbol}USDT`);
        const currentPrice = parseFloat(res.data.price);
        const pnl = ((currentPrice - trade.entry) / trade.entry) * 100;
        console.log(`📈 Trading ${trade.symbol} | PnL: ${pnl.toFixed(2)}%`);

        if (pnl >= 2.5 || pnl <= -1.2) {
            const sold = await executeOrder("sell", trade.symbol, (trade.qty * currentPrice).toFixed(2));
            if (sold) activeTrade = null;
        }
    } catch (e) { console.log("Exit check failed"); }
}

// 3. START SCANNER
cron.schedule('*/1 * * * *', runMultiScanner);
