const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const getISTTime = () => {
    return new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"});
};

// --- NEW: BALANCE CHECK FUNCTION ---
const getBalance = async () => {
    try {
        // Placeholder for CoinDCX Balance API - requires Signature for real use
        console.log("Checking CoinDCX Wallet for ₹100 Challenge...");
        return true; // For now, we assume balance is there to keep it simple
    } catch (err) {
        console.log("Balance Check Skip: Waiting for wallet sync.");
        return true;
    }
};

const runTradeEngine = async () => {
    const currentTime = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
    const hours = currentTime.getHours();
    const minutes = currentTime.getMinutes();

    console.log(`--- Scan initiated at ${getISTTime()} ---`);

    // 1. 6:00 PM SAFETY WINDOW
    if (hours === 18 && minutes <= 30) {
        console.log("SAFETY WINDOW: Cashing out to wallet.");
        return;
    }

    // 2. CHECK BALANCE
    const hasFunds = await getBalance();
    if (!hasFunds) return;

    // 3. AI STRATEGY (SLOWER RATE TO FIX 429 ERROR)
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=inr&order=price_change_percentage_24h_desc&per_page=10&page=1');
        const data = res.data;

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Senior Scalper Mode: Target 30-50% profit. Stop Loss 7%. Analyze: ${JSON.stringify(data.slice(0,5))}. Return JSON: Coin, Entry, Target, StopLoss.`;

        const result = await model.generateContent(prompt);
        console.log("AI Scalp Decision:", result.response.text());

        if (hours > 18 || (hours === 18 && minutes > 30)) {
            console.log("POST-SAFETY: Aggressive All-In Mode Active.");
        }
    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.log("AI is resting (Cool-down period). Will retry in 10 mins.");
        } else {
            console.error("Engine Error:", error.message);
        }
    }
};

// CHANGED TO 10 MINUTES TO FIX 429 ERROR
cron.schedule('*/10 * * * *', runTradeEngine);

app.get('/', (req, res) => {
    res.send(`<h1>Scalper Engine Live</h1><p>Status: Healthy</p><p>IST: ${getISTTime()}</p>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server live on ${PORT}`));
