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
            headers: {
                'X-AUTH-APIKEY': process.env.COINDCX_API_KEY,
                'X-AUTH-SIGNATURE': signature
            }
        });

        // This improved check finds USDT regardless of how CoinDCX labels it
        const usdtAsset = res.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        const balance = usdtAsset ? parseFloat(usdtAsset.balance) : 0;
        
        console.log(`Current Wallet Balance: ${balance} USDT`);
        return balance; 
    } catch (err) {
        console.log("Searching for USDT balance...");
        return 0;
    }
};

const placeUSDTOrder = async (coinSymbol, amount) => {
    try {
        const timeStamp = Date.now();
        const body = {
            "side": "buy",
            "order_type": "market_order",
            "market": `${coinSymbol}USDT`,
            "total_quantity": amount, 
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
        console.log(`🚀 SUCCESS: Bot bought ${coinSymbol} using ${amount} USDT!`);
    } catch (err) {
        console.log(`❌ Trade execution failed:`, err.response ? err.response.data : err.message);
    }
};

const runTradeEngine = async () => {
    console.log(`--- USDT Scalp Cycle: ${new Date().toLocaleTimeString()} ---`);
    const balance = await getUSDTBalance();
    
    if (balance < 1) {
        console.log("Balance too low or wallet empty. Ensure 1+ USDT is in 'Coins'.");
        return;
    }

    try {
        const marketData = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=10');
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const prompt = `Act as an aggressive crypto trader. Pick the ONE coin with the highest 5-minute pump potential. Return ONLY JSON: {"coin": "SYMBOL"}. Data: ${JSON.stringify(marketData.data.slice(0,3))}`;

        const result = await model.generateContent(prompt);
        const decision = JSON.parse(result.response.text().trim());

        if (decision.coin) {
            console.log(`🎯 AI Strategy: Buy ${decision.coin}. Executing...`);
            await placeUSDTOrder(decision.coin.toUpperCase(), balance);
        }
    } catch (error) {
        console.log("AI is analyzing market volatility...");
    }
};

cron.schedule('*/5 * * * *', runTradeEngine);
app.get('/', (req, res) => res.send("Bot Status: Active and Watching USDT"));
app.listen(process.env.PORT || 3000);
