const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// GLOBAL MEMORY (Persistence replacement for Render Free Tier)
let activeTrades = []; 
const FEES = 0.005; 

const sign = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

const getBalance = async () => {
    try {
        const body = { timestamp: Date.now() };
        const res = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': sign(body) }
        });
        const usdt = res.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        return usdt ? parseFloat(usdt.balance) : 0;
    } catch (err) { return 0; }
};

const getPrice = async (symbol) => {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        return parseFloat(res.data.price);
    } catch (err) { return null; }
};

const placeOrder = async (symbol, side, usdtAmount) => {
    try {
        const price = await getPrice(symbol);
        if (!price) return null;
        
        // FIX: Manual Quantity Calculation for CoinDCX
        const quantity = (usdtAmount / price).toFixed(5); 

        const body = {
            side,
            order_type: "market_order",
            market: `${symbol}USDT`,
            total_quantity: quantity,
            timestamp: Date.now()
        };

        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': sign(body) }
        });

        console.log(`✅ ${side.toUpperCase()} SUCCESS: ${symbol} | Qty: ${quantity}`);
        return { price, quantity };
    } catch (err) {
        console.error(`❌ Order Error: ${err.response?.data?.message || err.message}`);
        return null;
    }
};

const tradeEngine = async () => {
    console.log("🔍 SCANNING MARKET...");

    // 1. SELL LOGIC
    for (let i = activeTrades.length - 1; i >= 0; i--) {
        const trade = activeTrades[i];
        const currentPrice = await getPrice(trade.symbol);
        if (!currentPrice) continue;

        const pnl = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
        console.log(`📊 Tracking ${trade.symbol}: ${pnl.toFixed(2)}%`);

        if (pnl >= (10 + FEES * 100) || pnl <= -4) {
            const sold = await placeOrder(trade.symbol, "sell", trade.usdtAmount);
            if (sold) activeTrades.splice(i, 1);
        }
    }

    // 2. BUY LOGIC (Tuned for 1.92 USDT Balance)
    const balance = await getBalance();
    if (balance > 1.2 && activeTrades.length === 0) {
        const res = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=15');
        
        // Smart Filter: 2% to 10% movement only (Smart Money range)
        const coin = res.data.find(c => c.price_change_percentage_24h > 2 && c.price_change_percentage_24h < 10);

        if (coin) {
            const symbol = coin.symbol.toUpperCase();
            const usdtAmount = balance - 0.1; // Use almost full balance to pass min-order limits
            
            const bought = await placeOrder(symbol, "buy", usdtAmount);
            if (bought) {
                activeTrades.push({ symbol, entryPrice: bought.price, usdtAmount, quantity: bought.quantity });
            }
        }
    }
};

cron.schedule('*/5 * * * *', tradeEngine);
app.get('/', (req, res) => res.json({ status: "ALIVE", active: activeTrades }));
app.listen(process.env.PORT || 3000);
