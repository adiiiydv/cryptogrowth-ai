const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Bot Logic: Scanning every 5 minutes
cron.schedule('*/5 * * * *', async () => {
    console.log('--- Gemini AI Scanning for high-probability trades ---');
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = "Analyze the current BTC and ETH market trend. Should I Buy, Sell, or Hold? Return only the action.";
        
        const result = await model.generateContent(prompt);
        const response = await result.response;
        console.log("AI Decision:", response.text());
        
        // Your CoinDCX logic will trigger based on the decision above
    } catch (error) {
        console.error("Scanning Error:", error.message);
    }
});

app.get('/', (req, res) => {
    res.send('<h1>CryptoGrowth AI Engine (Free Edition) is Active</h1>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
