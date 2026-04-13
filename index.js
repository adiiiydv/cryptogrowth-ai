const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

const placeUSDTOrder = async (symbol, amount) => {
    try {
        console.log(`📡 Sending Market Buy for ${symbol}...`);
        const body = {
            "side": "buy",
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
        console.log(`🚀 MISSION SUCCESS: Bought ${symbol}!`);
    } catch (err) {
        console.log(`❌ Order Failed: Check if ${symbol}/USDT exists on CoinDCX.`);
    }
};

const runTradeEngine = async () => {
    const balance = await getUSDTBalance();
    console.log(`--- FAST SCAN: Balance ${balance} USDT ---`);
    
    if (balance < 0.5) {
        console.log("No USDT to trade. Order already filled or wallet empty.");
        return;
    }

    try {
        const marketData = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=5');
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        // FORCED COMMAND: No waiting allowed.
        const prompt = `COMMAND: You are a high-speed scalper. You MUST pick the best coin from this list to buy NOW. Do not explain. Return ONLY JSON: {"coin": "SYMBOL"}. Data: ${JSON.stringify(marketData.data)}`;

        const result = await model.generateContent(prompt);
        const decision = JSON.parse(result.response.text().trim());

        if (decision.coin) {
            console.log(`🎯 AI FORCE-PICK: ${decision.coin}. executing trade...`);
            await placeUSDTOrder(decision.coin.toUpperCase(), balance);
        }
    } catch (error) {
        console.log("System glitch, retrying in 2 mins...");
    }
};

// Faster 2-minute interval
cron.schedule('*/2 * * * *', runTradeEngine);

app.get('/', (req, res) => res.send("Rapid-Trader Active"));
app.listen(process.env.PORT || 3000);
