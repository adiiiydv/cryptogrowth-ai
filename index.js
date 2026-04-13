const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
let sniperPosition = null; 

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

const fastOrder = async (symbol, side, usdtAmount) => {
    try {
        // Fetch current price to calculate exact quantity
        const priceRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        const price = parseFloat(priceRes.data.price);
        
        // Quantity must be precise to 5-6 decimals for micro-trades
        const quantity = (usdtAmount / price).toFixed(5); 

        const body = {
            side,
            order_type: "market_order",
            market: `${symbol}USDT`,
            total_quantity: quantity,
            timestamp: Date.now()
        };

        const res = await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': sign(body) }
        });

        console.log(`⚡ INSTANT ${side.toUpperCase()}: ${symbol} | Qty: ${quantity}`);
        return { price, quantity };
    } catch (err) {
        console.error(`❌ Order Blocked: ${err.response?.data?.message || "Exchange Limit reached"}`);
        return null;
    }
};

const sniperEngine = async () => {
    console.log("🚀 TRIGGERING RAPID SCAN...");

    if (sniperPosition) {
        // Exit Logic: Sell at 10% profit or 3% loss immediately
        const priceRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${sniperPosition.symbol}USDT`);
        const pnl = ((parseFloat(priceRes.data.price) - sniperPosition.entryPrice) / sniperPosition.entryPrice) * 100;
        
        if (pnl >= 10 || pnl <= -3) {
            const sold = await fastOrder(sniperPosition.symbol, "sell", sniperPosition.amount);
            if (sold) sniperPosition = null;
        }
        return;
    }

    const balance = await getBalance();
    // Force target: 1.85 USDT to leave a small buffer for fees (1% TDS/Fees)
    if (balance >= 1.85) {
        const res = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=50');
        
        // Target coins priced below $2 to ensure your 1.9 USDT can buy a significant quantity
        const target = res.data.find(c => c.current_price < 2.0 && c.total_volume > 1000000);

        if (target) {
            const symbol = target.symbol.toUpperCase();
            const bought = await fastOrder(symbol, "buy", 1.85); 
            if (bought) {
                sniperPosition = { symbol, entryPrice: bought.price, amount: 1.85 };
            }
        }
    } else {
        console.log(`⚠️ Balance too low for sniper (${balance} USDT)`);
    }
};

// Check every 5 minutes for maximum speed without hitting rate limits
cron.schedule('*/2 * * * *', sniperEngine);
app.listen(process.env.PORT || 3000);
