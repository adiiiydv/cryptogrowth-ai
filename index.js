require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

// 🔐 Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 🕒 IST Time
const getISTTime = () => {
    return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
};

// 💰 Balance Check (Mock for now)
const getBalance = async () => {
    try {
        console.log("Checking wallet balance...");
        // Future: connect CoinDCX API here
        return true;
    } catch (err) {
        console.error("Balance error:", err.message);
        return false;
    }
};

// 🤖 AI Decision Function
const getAIDecision = async (marketData) => {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const prompt = `
You are a professional crypto scalper.

Rules:
- Target profit: 10-20% (realistic)
- Stop loss: 5-7%
- Give only JSON output

Analyze this data:
${JSON.stringify(marketData)}

Return format:
{
  "coin": "",
  "entry": "",
  "target": "",
  "stopLoss": "",
  "confidence": ""
}
`;

        const result = await model.generateContent(prompt);
        const text = result.response.text();

        return text;

    } catch (err) {
        if (err.message.includes("429")) {
            console.log("Gemini rate limit hit. Cooling down...");
        } else {
            console.error("AI Error:", err.message);
        }
        return null;
    }
};

// 📊 Main Trading Engine
const runTradeEngine = async () => {
    console.log(`\n--- Engine Run at ${getISTTime()} ---`);

    try {
        // 🛑 Balance Check
        const hasFunds = await getBalance();
        if (!hasFunds) {
            console.log("No funds. Skipping...");
            return;
        }

        // 📊 Fetch Market Data
        const response = await axios.get(
            'https://api.coingecko.com/api/v3/coins/markets',
            {
                params: {
                    vs_currency: 'inr',
                    order: 'price_change_percentage_24h_desc',
                    per_page: 5,
                    page: 1
                },
                timeout: 10000
            }
        );

        const marketData = response.data;

        if (!marketData || marketData.length === 0) {
            console.log("No market data received.");
            return;
        }

        console.log("Top Coins Fetched ✅");

        // 🤖 AI Decision
        const decision = await getAIDecision(marketData);

        if (!decision) {
            console.log("No AI decision.");
            return;
        }

        console.log("AI Decision 👇");
        console.log(decision);

        // 🚧 NOTE:
        // Here you will later:
        // - Parse JSON
        // - Execute trade
        // - Track target / stop loss

    } catch (err) {
        console.error("Engine Error:", err.message);
    }
};

// ⏱ Run every 10 minutes (safe for free APIs)
cron.schedule('*/10 * * * *', runTradeEngine);

// 🌐 Web Status
app.get('/', (req, res) => {
    res.send(`
        <h1>🚀 Crypto Engine Running</h1>
        <p>Status: ACTIVE</p>
        <p>Time (IST): ${getISTTime()}</p>
    `);
});

// 🚀 Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
