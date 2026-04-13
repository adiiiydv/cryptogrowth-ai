const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 1. Check Balance
const getUSDTBalance = async () => {
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
    } catch (err) { return 0; }
};

// 2. Buy/Sell Execution
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
        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signature }
        });
        console.log(`🚀 ${side.toUpperCase()} SUCCESS: ${symbol}`);
    } catch (err) { console.log(`❌ ${side} Error:`, err.message); }
};

const runTradeEngine = async () => {
    const balance = await getUSDTBalance();
    console.log(`--- Scan: Balance ${balance} USDT ---`);

    try {
        const marketData = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&price_change_percentage=24h');
        
        // FIND COIN WITH 20% JUMP
        const hotCoin = marketData.data.find(coin => coin.price_change_percentage_24h >= 20);

        if (hotCoin && balance > 1) {
            console.log(`🔥 20% JUMP CONFIRMED: Buying ${hotCoin.symbol.toUpperCase()}`);
            await executeTrade(hotCoin.symbol.toUpperCase(), balance, "buy");
            
            // SET EXIT LOGIC (7-10% Profit or 4% Loss)
            const entryPrice = hotCoin.current_price;
            console.log(`Target Profit: ${entryPrice * 1.10} | Stop Loss: ${entryPrice * 0.96}`);
        } else {
            console.log("No coins showing 20% jump right now. Staying safe.");
        }
    } catch (error) { console.log("Market scanning..."); }
};

// Check every 5 minutes for safety
cron.schedule('*/5 * * * *', runTradeEngine);
app.get('/', (req, res) => res.send("Smart Bot Live: Waiting for 20% Signal"));
app.listen(process.env.PORT || 3000);
