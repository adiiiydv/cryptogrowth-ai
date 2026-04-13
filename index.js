const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
let activeTrades = []; 

const sign = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

const getBalance = async () => {
    try {
        const body = { timestamp: Date.now() };
        const res = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': sign(body) }
        });
        const usdt = res.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        return usdt ? parseFloat(usdt.balance) : 0;
    } catch (err) { return 0; }
};

const placeOrder = async (symbol, side, usdtAmount) => {
    try {
        const priceRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        const price = parseFloat(priceRes.data.price);
        const quantity = (usdtAmount / price).toFixed(5); 

        const body = {
            side,
            order_type: "market_order",
            market: `${symbol}USDT`,
            total_quantity: quantity,
            timestamp: Date.now()
        };

        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': sign(body) }
        });

        console.log(`🚀 ${side.toUpperCase()} SUCCESS: ${symbol} @ ${price}`);
        return { price, quantity };
    } catch (err) {
        console.error(`❌ EXECUTION FAILED: ${err.response?.data?.message || err.message}`);
        return null;
    }
};

const forceTrade = async () => {
    console.log("⚡ FORCE SCANNING FOR IMMEDIATE ENTRY...");

    // 1. Manage existing trades
    for (let i = activeTrades.length - 1; i >= 0; i--) {
        const trade = activeTrades[i];
        const priceRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${trade.symbol}USDT`);
        const currentPrice = parseFloat(priceRes.data.price);
        const pnl = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
        
        console.log(`📊 Tracking ${trade.symbol}: ${pnl.toFixed(2)}%`);
        if (pnl >= 10 || pnl <= -4) {
            const sold = await placeOrder(trade.symbol, "sell", trade.usdtAmount);
            if (sold) activeTrades.splice(i, 1);
        }
    }

    // 2. FORCE BUY (If wallet has 1.92 USDT and no open trades)
    const balance = await getBalance();
    if (balance > 1.2 && activeTrades.length === 0) {
        const res = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=5');
        
        // Grab the #1 gainer regardless of strict filters to force action
        const topCoin = res.data[0];
        const symbol = topCoin.symbol.toUpperCase();
        const tradeAmt = (balance - 0.05).toFixed(2); 

        console.log(`🔥 Forcing Buy on ${symbol} to trigger execution...`);
        const bought = await placeOrder(symbol, "buy", tradeAmt);
        if (bought) {
            activeTrades.push({ symbol, entryPrice: bought.price, usdtAmount: tradeAmt });
        }
    }
};

// 5-min interval to avoid 429 errors
cron.schedule('*/5 * * * *', forceTrade);
app.get('/', (req, res) => res.json({ status: "ACTIVE", trades: activeTrades }));
app.listen(process.env.PORT || 3000);
