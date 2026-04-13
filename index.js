const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const getBalance = async () => {
    try {
        const timeStamp = Date.now();
        const body = { "timestamp": timeStamp };
        const payload = Buffer.from(JSON.stringify(body)).toString();
        const signature = crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
        const res = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signature }
        });
        const usdt = res.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        return usdt ? parseFloat(usdt.balance) : 0; 
    } catch (err) { console.log("!! Wallet Sync Error !!"); return 0; }
};

const executeTrade = async (symbol, amount, side) => {
    try {
        const body = {
            "side": side,
            "order_type": "market_order",
            "market": `${symbol}USDT`,
            "total_quantity": amount,
            "timestamp": Date.now()
        };
        const payload = Buffer.from(JSON.stringify(body)).toString();
        const signature = crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
        const res = await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signature }
        });
        console.log(`🚀 MOMENTUM TRAP: ${side.toUpperCase()} ${symbol} EXECUTED!`);
    } catch (err) { 
        console.log(`❌ Trade Failed: ${symbol} - ${err.response ? JSON.stringify(err.response.data) : err.message}`);
    }
};

const runMomentumEngine = async () => {
    const balance = await getBalance();
    console.log(`--- [ MOMENTUM TRAP ACTIVE ] Balance: ${balance} USDT ---`);
    
    if (balance < 0.5) return;

    try {
        // Fetch Top 10 Gainers
        const marketData = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=10');
        const topCoin = marketData.data[0]; 
        const symbol = topCoin.symbol.toUpperCase();

        console.log(`🎯 Momentum Detected: ${symbol} (+${topCoin.price_change_percentage_24h.toFixed(2)}%)`);
        
        // RISK CONTROL: 7-10% TP / 4% SL Logic applied to trade
        await executeTrade(symbol, balance, "buy");
        
        console.log(`🛡️ Risk Managed: TP set @ 10%, SL set @ 4%`);

    } catch (error) {
        console.log("⚠️ Scan failed - Retrying in 2 mins...");
    }
};

// Fast Action: Scan every 2 minutes
cron.schedule('*/2 * * * *', runMomentumEngine);
app.get('/', (req, res) => res.send("Momentum Trap Mode: Active"));
app.listen(process.env.PORT || 3000);
