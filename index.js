const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 1. Function to place the actual trade
const placeOrder = async (coinSymbol) => {
    try {
        const timeStamp = Date.now();
        const body = {
            "side": "buy",
            "order_type": "market_order",
            "market": `${coinSymbol}INR`,
            "total_quantity": 100, // Fixed amount for the ₹100 challenge
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
        console.log(`🚀 SUCCESS: Bought ${coinSymbol}! Order ID: ${res.data.id}`);
    } catch (err) {
        console.log(`❌ Trade Failed for ${coinSymbol}:`, err.response ? err.response.data : err.message);
    }
};

const getBalance = async () => {
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
        const inr = res.data.find(b => b.currency === 'INR' || b.asset === 'INR');
        const balance = inr ? parseFloat(inr.balance) : 0;
        console.log(`Wallet Balance: ₹${balance}`);
        return balance >= 100;
    } catch (err) {
        console.log("Syncing Wallet...");
        return false;
    }
};

const runTradeEngine = async () => {
    console.log(`--- Scalp Scan: ${new Date().toLocaleTimeString()} ---`);
    const hasFunds = await getBalance();
    
    if (!hasFunds) {
        console.log("Waiting for INR in Coins Wallet...");
        return;
    }

    try {
        const marketData = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=inr&order=price_change_percentage_24h_desc&per_page=10');
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        const prompt = `You are an aggressive scalper. Pick the ONE best coin to buy NOW for 30% profit. 
        Return ONLY JSON format: {"coin": "SYMBOL"} (e.g. {"coin": "SOL"}). 
        Data: ${JSON.stringify(marketData.data.slice(0,5))}`;

        const result = await model.generateContent(prompt);
        const decision = JSON.parse(result.response.text().trim());

        if (decision.coin) {
            console.log(`🎯 AI Selected: ${decision.coin}. Executing Market Buy...`);
            await placeOrder(decision.coin.toUpperCase());
        }
    } catch (error) {
        console.log("Engine paused or parsing error. Retrying next cycle.");
    }
};

// Runs every 5 minutes
cron.schedule('*/5 * * * *', runTradeEngine);

app.get('/', (req, res) => res.send("Auto-Trader Live"));
app.listen(process.env.PORT || 3000);
