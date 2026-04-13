const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 1. Function to Buy using USDT
const placeUSDTOrder = async (coinSymbol, amount) => {
    try {
        const timeStamp = Date.now();
        const body = {
            "side": "buy",
            "order_type": "market_order",
            "market": `${coinSymbol}USDT`, // Switched to USDT market
            "total_quantity": amount,     // Uses your full USDT balance
            "timestamp": timeStamp
        };

        const payload = Buffer.from(JSON.stringify(body)).toString();
        const signature = crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');

        const res = await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: {
                'X-AUTH-APIKEY': process.env.COINDCX_API_KEY,
                'X-AUTH-SIGNATURE': signature
            }
        });
        console.log(`🚀 USDT TRADE SUCCESS: Bought ${coinSymbol}!`);
    } catch (err) {
        console.log(`❌ USDT Trade Failed:`, err.response ? err.response.data : err.message);
    }
};

// 2. Function to check USDT Balance
const getUSDTBalance = async () => {
    try {
        const timeStamp = Date.now();
        const body = { "timestamp": timeStamp };
        const payload = Buffer.from(JSON.stringify(body)).toString();
        const signature = crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');

        const res = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: {
                'X-AUTH-APIKEY': process.env.COINDCX_API_KEY,
                'X-AUTH-SIGNATURE': signature
            }
        });
        // Look for USDT instead of INR
        const usdtAsset = res.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        const balance = usdtAsset ? parseFloat(usdtAsset.balance) : 0;
        console.log(`USDT Wallet Balance: ${balance}`);
        return balance; 
    } catch (err) {
        console.log("Checking USDT Wallet...");
        return 0;
    }
};

const runTradeEngine = async () => {
    console.log(`--- USDT Scalp Scan: ${new Date().toLocaleTimeString()} ---`);
    const balance = await getUSDTBalance();
    
    // Bot needs at least 1 USDT to trade
    if (balance < 1) {
        console.log("Waiting for USDT in Coins Wallet...");
        return;
    }

    try {
        const marketData = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=10');
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        const prompt = `You are an aggressive USDT scalper. Pick the ONE best coin to buy with USDT for a 30% pump. 
        Return ONLY JSON format: {"coin": "SYMBOL"} (e.g. {"coin": "SOL"}). 
        Data: ${JSON.stringify(marketData.data.slice(0,5))}`;

        const result = await model.generateContent(prompt);
        const decision = JSON.parse(result.response.text().trim());

        if (decision.coin) {
            console.log(`🎯 AI Selected: ${decision.coin}. Buying with ${balance} USDT...`);
            await placeUSDTOrder(decision.coin.toUpperCase(), balance);
        }
    } catch (error) {
        console.log("AI deciding or Market busy...");
    }
};

cron.schedule('*/5 * * * *', runTradeEngine);

app.get('/', (req, res) => res.send("USDT Auto-Trader Active"));
app.listen(process.env.PORT || 3000);
