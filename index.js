const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
let sniperPosition = null; // Memory to track our active hunt

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

const sniperTrade = async (symbol, side, usdtAmount) => {
    try {
        const priceRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        const price = parseFloat(priceRes.data.price);
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

        console.log(`🎯 SNIPER ${side.toUpperCase()}: ${symbol} at ${price}`);
        return { price, quantity };
    } catch (err) {
        console.error(`❌ Sniper Missed: ${err.response?.data?.message || err.message}`);
        return null;
    }
};

const runSniper = async () => {
    console.log("⚡ SNIPER SCANNING...");

    // 1. EXIT SYSTEM (The 'Take Profit' or 'Cut Loss')
    if (sniperPosition) {
        const priceRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${sniperPosition.symbol}USDT`);
        const currentPrice = parseFloat(priceRes.data.price);
        const pnl = ((currentPrice - sniperPosition.entryPrice) / sniperPosition.entryPrice) * 100;

        console.log(`📊 Sniper Tracking ${sniperPosition.symbol}: ${pnl.toFixed(2)}%`);
        
        // Target high-growth (12% profit) or fast exit (-4% loss)
        if (pnl >= 12 || pnl <= -4) {
            const sold = await sniperTrade(sniperPosition.symbol, "sell", sniperPosition.usdtAmount);
            if (sold) sniperPosition = null;
        }
        return;
    }

    // 2. ENTRY SYSTEM (The 'Snipe')
    const balance = await getBalance();
    if (balance > 1.2) {
        const market = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=10');
        
        // Pick the top volatility coin (excluding extreme pumps over 25%)
        const target = market.data.find(c => c.price_change_percentage_24h < 25);
        if (target) {
            const symbol = target.symbol.toUpperCase();
            const amount = (balance - 0.05).toFixed(2);
            
            const bought = await sniperTrade(symbol, "buy", amount);
            if (bought) {
                sniperPosition = { symbol, entryPrice: bought.price, usdtAmount: amount };
            }
        }
    }
};

// 5-minute cooldown to avoid API blocks
cron.schedule('*/5 * * * *', runSniper);
app.listen(process.env.PORT || 3000);
