const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
// SAFE MEMORY: Tracks your active trade details
let activeTrade = null; 

const getBalance = async () => {
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

const executeTrade = async (symbol, amount, side) => {
    try {
        const body = {
            "side": side,
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
        return res.data;
    } catch (err) {
        console.log(`❌ trade_error: ${symbol} ${side} failed. Check pair availability.`);
        return null;
    }
};

const runTradeEngine = async () => {
    const balance = await getBalance();
    
    // 1. SELL LOGIC: Check if active trade needs to be closed
    if (activeTrade) {
        try {
            const priceRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${activeTrade.symbol}USDT`);
            const currentPrice = parseFloat(priceRes.data.price);
            const pnl = ((currentPrice - activeTrade.entryPrice) / activeTrade.entryPrice) * 100;

            console.log(`📊 Tracking ${activeTrade.symbol}: PNL ${pnl.toFixed(2)}%`);

            if (pnl >= 10 || pnl <= -4) {
                console.log(`🎯 TARGET REACHED. Selling ${activeTrade.symbol}...`);
                const sold = await executeTrade(activeTrade.symbol, activeTrade.amount, "sell");
                if (sold) activeTrade = null; // Clear memory after sell
            }
            return; // Don't buy new while holding
        } catch (e) { console.log("!! Price Sync Error !!"); return; }
    }

    // 2. BUY LOGIC: Find a smart entry
    if (balance < 0.5) return;

    try {
        const market = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=20');
        
        // MOMENTUM FILTER: Min 5%, Max 20% (Prevents buying the peak)
        const candidates = market.data.filter(c => c.price_change_percentage_24h > 5 && c.price_change_percentage_24h < 20);
        
        if (candidates.length > 0) {
            const topCoin = candidates[0];
            const symbol = topCoin.symbol.toUpperCase();
            const tradeAmount = (balance * 0.2).toFixed(2); // 20% Position Sizing

            console.log(`🚀 Smart Entry: ${symbol} at $${topCoin.current_price}`);
            
            const bought = await executeTrade(symbol, tradeAmount, "buy");
            if (bought) {
                activeTrade = {
                    symbol: symbol,
                    entryPrice: topCoin.current_price,
                    amount: tradeAmount
                };
            }
        }
    } catch (error) { console.log("Searching for fresh momentum..."); }
};

cron.schedule('*/2 * * * *', runTradeEngine);
app.listen(process.env.PORT || 3000);
