const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
// FIX: Using the correct initialization for the latest library version
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
        console.log("Syncing with CoinDCX...");
        return false;
    }
};

const runTradeEngine = async () => {
    console.log(`--- Scan initiated at ${new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"})} ---`);
    
    const hasFunds = await getBalance();
    if (!hasFunds) {
        console.log("Waiting for ₹100 deposit to show in API...");
        return;
    }

    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=inr&order=price_change_percentage_24h_desc&per_page=10');
        
        // FIX: Ensuring the model name is exactly what Google expects
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = "Analyze these coins for a 30% profit pump. Return JSON with 'coin', 'target', and 'stoploss': " + JSON.stringify(res.data.slice(0,5));

        const result = await model.generateContent(prompt);
        console.log("AI Scalp Decision:", result.response.text());
    } catch (error) {
        console.error("Engine Note: AI is cooling down or model busy. Retrying in 10 mins.");
    }
};

cron.schedule('*/10 * * * *', runTradeEngine);

app.get('/', (req, res) => res.send("Scalper Engine Live"));
app.listen(process.env.PORT || 3000);
