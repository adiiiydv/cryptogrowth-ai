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
            headers: {
                'X-AUTH-APIKEY': process.env.COINDCX_API_KEY,
                'X-AUTH-SIGNATURE': signature
            }
        });
        // Check for INR in the balance array
        const inr = res.data.find(b => b.currency === 'INR' || b.asset === 'INR');
        const balance = inr ? parseFloat(inr.balance) : 0;
        console.log(`Wallet Balance: ₹${balance}`);
        return balance >= 100;
    } catch (err) {
        console.log("CoinDCX Syncing...");
        return false;
    }
};

const runTradeEngine = async () => {
    console.log(`--- Scan: ${new Date().toLocaleTimeString()} ---`);
    const hasFunds = await getBalance();
    
    if (!hasFunds) {
        console.log("Waiting for INR deposit... Check CoinDCX Wallet.");
        return;
    }

    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=inr&order=price_change_percentage_24h_desc&per_page=15');
        
        // Using the newer model version
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        // STRICT JSON PROMPT
        const prompt = `Return ONLY a raw JSON object for the best trade. 
        Target: 30% profit. Stoploss: 7%. 
        Data: ${JSON.stringify(res.data.slice(0,5))}
        Format: {"coin": "NAME", "target": "30%", "stoploss": "7%"}`;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        
        // Log the decision
        console.log("AI JSON DECISION:", responseText);
    } catch (error) {
        console.log("AI resting for a moment (Rate limit).");
    }
};

// Set to 5 minutes to avoid the 429 Error from your last log
cron.schedule('*/5 * * * *', runTradeEngine);

app.get('/', (req, res) => res.send("Scalper Engine Active"));
app.listen(process.env.PORT || 3000);
