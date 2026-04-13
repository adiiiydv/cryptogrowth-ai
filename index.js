const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// ---- CONFIG ----
const TRADE_PERCENT = 0.5; // Increased to 50% to help meet CoinDCX min order limits
const MAX_TRADES = 2;
const TAKE_PROFIT = 10;
const STOP_LOSS = -4;

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
        console.log(`✅ ${side.toUpperCase()} ${symbol}`);
    } catch (err) {
        console.error(`❌ Order Error (${symbol}):`, err.response?.data || err.message);
    }
};

// FIXED: Uses Markets API for better symbol-to-price matching
const getPrice = async (symbol) => {
    try {
        const res = await axios.get(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&symbols=${symbol.toLowerCase()}`);
        return res.data[0]?.current_price;
    } catch (err) { return null; }
};

const engine = async () => {
    try {
        console.log(`🔍 SCAN START: ${new Date().toLocaleTimeString()}`);
        
        // 1. SELL CHECK
        for (let trade of activeTrades) {
            const currentPrice = await getPrice(trade.symbol);
            if (!currentPrice) continue;

            const pnl = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
            console.log(`📊 ${trade.symbol} PnL: ${pnl.toFixed(2)}%`);

            if (pnl >= TAKE_PROFIT || pnl <= STOP_LOSS) {
                await placeOrder(trade.symbol, "sell", trade.amount);
                activeTrades = activeTrades.filter(t => t.symbol !== trade.symbol);
            }
        }

        // 2. BUY CHECK
        const balance = await getBalance();
        if (balance > 1 && activeTrades.length < MAX_TRADES) {
            const market = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=15');
            
            const filtered = market.data.filter(c => 
                c.price_change_percentage_24h > 3 && 
                c.price_change_percentage_24h < 15 && 
                c.total_volume > 1000000
            );

            if (filtered.length > 0) {
                const pick = filtered[1] || filtered[0];
                const symbol = pick.symbol.toUpperCase();

                if (!activeTrades.find(t => t.symbol === symbol)) {
                    const tradeAmount = (balance * TRADE_PERCENT).toFixed(2);
                    await placeOrder(symbol, "buy", tradeAmount);
                    activeTrades.push({ symbol, entryPrice: pick.current_price, amount: tradeAmount });
                }
            }
        }
    } catch (err) { console.log("Engine cooling down..."); }
};

// --- UPDATED TO 5 MINUTES ---
cron.schedule('*/5 * * * *', engine);

app.get('/', (req, res) => res.send("5-Min Smart Bot Active"));
app.listen(process.env.PORT || 3000);
