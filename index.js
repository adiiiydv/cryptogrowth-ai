const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
let activeTrades = []; // Safe Memory

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

const placeOrder = async (symbol, side, amount) => {
    try {
        const body = {
            side,
            order_type: "market_order",
            market: `${symbol}USDT`,
            total_quantity: amount,
            timestamp: Date.now()
        };
        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': sign(body) }
        });
        console.log(`✅ ${side.toUpperCase()} SUCCESS: ${symbol}`);
    } catch (err) { console.log(`❌ Order failed: ${symbol}`); }
};

// Fixed Price Logic
const getPrice = async (symbol) => {
    try {
        const res = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${symbol.toLowerCase()}&vs_currencies=usd`);
        const idMap = { "BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "DOGE": "dogecoin" };
        const id = idMap[symbol] || symbol.toLowerCase();
        const price = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
        return price.data[id].usd;
    } catch (e) { return null; }
};

const tradeEngine = async () => {
    console.log("🔍 Scanning for Alpha...");
    
    // 1. SELL LOGIC: +10% or -4%
    for (let trade of activeTrades) {
        const currentPrice = await getPrice(trade.symbol);
        if (!currentPrice) continue;
        const pnl = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
        
        if (pnl >= 10 || pnl <= -4) {
            await placeOrder(trade.symbol, "sell", trade.amount);
            activeTrades = activeTrades.filter(t => t.symbol !== trade.symbol);
        }
    }

    // 2. BUY LOGIC: 50% Capital
    const balance = await getBalance();
    if (balance > 1 && activeTrades.length === 0) {
        const market = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=10');
        
        // Smart Money Filter: Min 3%, Max 15%
        const coin = market.data.find(c => c.price_change_percentage_24h > 3 && c.price_change_percentage_24h < 15);
        
        if (coin) {
            const symbol = coin.symbol.toUpperCase();
            const tradeAmt = (balance * 0.5).toFixed(2); // 50% to clear min-order limits
            await placeOrder(symbol, "buy", tradeAmt);
            activeTrades.push({ symbol, entryPrice: coin.current_price, amount: tradeAmt });
        }
    }
};

// --- 5-Min Interval to stop Error 429 ---
cron.schedule('*/5 * * * *', tradeEngine);
app.get('/', (req, res) => res.send("Bot Active: " + activeTrades.length + " trades open."));
app.listen(process.env.PORT || 3000);
