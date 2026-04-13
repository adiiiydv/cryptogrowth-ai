const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
// Persistence: Safe Memory for Active Trades
let activeTrades = []; 

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
    } catch (err) { console.error("!! Balance Sync Failed !!"); return 0; }
};

const placeOrder = async (symbol, side, amount) => {
    try {
        const body = {
            side,
            order_type: "market_order",
            market: `${symbol}USDT`,
            total_quantity: amount,
            timestamp: Date.now()
        };
        const res = await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': sign(body) }
        });
        console.log(`🎯 ${side.toUpperCase()} EXECUTED: ${symbol} | Qty: ${amount}`);
        return res.data;
    } catch (err) {
        console.error(`❌ Order Error: ${symbol} - ${err.response?.data?.message || err.message}`);
        return null;
    }
};

// Fixed Symbol Mapping & Price Fetch
const getPrice = async (symbol) => {
    try {
        // Fetching multiple at once to save API weight
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        return parseFloat(res.data.price);
    } catch (err) { return null; }
};

const tradeEngine = async () => {
    console.log("🔍 [CRITICAL SCAN] Checking Positions...");
    
    // 1. SELL SYSTEM: Fee-Adjusted (Net 10% Profit)
    for (let i = activeTrades.length - 1; i >= 0; i--) {
        const trade = activeTrades[i];
        const currentPrice = await getPrice(trade.symbol);
        if (!currentPrice) continue;

        const pnl = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
        console.log(`📊 ${trade.symbol} Tracking: ${pnl.toFixed(2)}%`);

        // Profit target 10.5% (to cover ~0.5% round-trip fees) or 4% Loss
        if (pnl >= 10.5 || pnl <= -4) {
            const sold = await placeOrder(trade.symbol, "sell", trade.amount);
            if (sold) activeTrades.splice(i, 1);
        }
    }

    // 2. BUY SYSTEM: Full Capital Strategy
    const balance = await getBalance();
    if (balance > 1.2 && activeTrades.length === 0) {
        try {
            const market = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=15');
            
            // Filter: 5% to 12% (Momentum without the Overpump Trap)
            const pick = market.data.find(c => c.price_change_percentage_24h > 5 && c.price_change_percentage_24h < 12);
            
            if (pick) {
                const symbol = pick.symbol.toUpperCase();
                const tradeAmount = balance.toFixed(2); // Use full current balance to meet exchange minimums
                
                const bought = await placeOrder(symbol, "buy", tradeAmount);
                if (bought) {
                    activeTrades.push({
                        symbol,
                        entryPrice: pick.current_price,
                        amount: tradeAmount
                    });
                }
            }
        } catch (e) { console.error("Market Data Unavailable"); }
    }
};

// 5-Minute loop to stay under rate limits
cron.schedule('*/5 * * * *', tradeEngine);
app.listen(process.env.PORT || 3000);
