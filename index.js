const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Function to check IST Time
const getISTTime = () => {
    const now = new Date();
    return now.toLocaleString("en-US", {timeZone: "Asia/Kolkata"});
};

// 1. DATA FETCHING
const getMarketData = async () => {
    // Fetching high-volatility coins for quick gains
    const res = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=inr&order=price_change_percentage_24h_desc&per_page=10&page=1');
    return res.data;
};

// 2. AI TRADING ENGINE
const runTradeEngine = async () => {
    const currentTime = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
    const hours = currentTime.getHours();
    const minutes = currentTime.getMinutes();

    console.log(`--- Checking Market at ${getISTTime()} ---`);

    // SAFETY WINDOW: 6:00 PM to 6:30 PM (No new trades, Cash out)
    if (hours === 18 && minutes <= 30) {
        console.log("6:00 PM SAFETY WINDOW: Closing positions, updating wallet balance...");
        // Logic to call CoinDCX sellAll() goes here
        return;
    }

    try {
        const data = await getMarketData();
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const prompt = `You are a Senior Crypto Scalper. Strategy:
        1. Target: Short-term 30-50% profit.
        2. Exit: sell at 30-35% gain.
        3. Safety: HARD STOP LOSS at 7% loss.
        4. Current Market Data: ${JSON.stringify(data.slice(0,5))}.
        
        Analyze which coin will pump next for the ₹100 to ₹1 Lakh challenge.
        Provide: Coin ID, Entry Price, Take Profit (35%), Stop Loss (-7%), and Reasoning.
        Format: JSON only.`;

        const result = await model.generateContent(prompt);
        const response = result.response.text();
        console.log("AI Decision:", response);

        // After 6:30 PM logic: "Invest All"
        if (hours >= 18 && minutes > 30 || hours > 18) {
            console.log("Post-Safety Window: Aggressive All-In Mode Active.");
        }

    } catch (error) {
        console.error("Engine Error:", error.message);
    }
};

// Run every 5 minutes
cron.schedule('*/5 * * * *', runTradeEngine);

app.get('/', (req, res) => {
    res.send(`<h1>CryptoGrowth AI: Scalper Mode Active</h1><p>Last Scan: ${getISTTime()}</p>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scalper Engine Live on Port ${PORT}`));
