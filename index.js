const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// ---- CONFIG ----
const TRADE_PERCENT = 0.2;
const MAX_TRADES = 3;
const TAKE_PROFIT = 10;
const STOP_LOSS = -4;

// SAFE MEMORY (multi trades)
let activeTrades = [];

// ---- SIGN ----
const sign = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY)
        .update(payload)
        .digest('hex');
};

// ---- BALANCE ----
const getBalance = async () => {
    try {
        const body = { timestamp: Date.now() };
        const res = await axios.post(
            'https://api.coindcx.com/exchange/v1/users/balances',
            body,
            {
                headers: {
                    'X-AUTH-APIKEY': process.env.COINDCX_API_KEY,
                    'X-AUTH-SIGNATURE': sign(body)
                }
            }
        );

        const usdt = res.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        return usdt ? parseFloat(usdt.balance) : 0;

    } catch (err) {
        console.error("❌ Balance Error:", err.response?.data || err.message);
        throw err;
    }
};

// ---- ORDER ----
const placeOrder = async (symbol, side, amount) => {
    try {
        const body = {
            side,
            order_type: "market_order",
            market: `${symbol}USDT`,
            total_quantity: amount,
            timestamp: Date.now()
        };

        await axios.post(
            'https://api.coindcx.com/exchange/v1/orders/create',
            body,
            {
                headers: {
                    'X-AUTH-APIKEY': process.env.COINDCX_API_KEY,
                    'X-AUTH-SIGNATURE': sign(body)
                }
            }
        );

        console.log(`✅ ${side.toUpperCase()} ${symbol}`);

    } catch (err) {
        console.error(`❌ Order Error (${symbol}):`, err.response?.data || err.message);
        throw err;
    }
};

// ---- PRICE ----
const getPrice = async (symbol) => {
    const res = await axios.get(
        `https://api.coingecko.com/api/v3/simple/price?ids=${symbol.toLowerCase()}&vs_currencies=usd`
    );
    return res.data[symbol.toLowerCase()]?.usd;
};

// ---- SELL SYSTEM ----
const checkAndSell = async () => {
    for (let trade of activeTrades) {
        try {
            const price = await getPrice(trade.symbol);
            if (!price) continue;

            const pnl = ((price - trade.entryPrice) / trade.entryPrice) * 100;

            console.log(`📊 ${trade.symbol} PnL: ${pnl.toFixed(2)}%`);

            if (pnl >= TAKE_PROFIT || pnl <= STOP_LOSS) {
                console.log(`💰 EXIT ${trade.symbol}`);
                await placeOrder(trade.symbol, "sell", trade.amount);

                // remove trade safely
                activeTrades = activeTrades.filter(t => t.symbol !== trade.symbol);
            }

        } catch (err) {
            console.error("❌ Sell Check Error:", err.message);
        }
    }
};

// ---- BUY SYSTEM ----
const findTrades = async () => {
    const balance = await getBalance();

    if (balance < 1) return;
    if (activeTrades.length >= MAX_TRADES) return;

    const market = await axios.get(
        'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=10'
    );

    // FILTERING (SMART MONEY LOGIC)
    const filtered = market.data.filter(c =>
        c.price_change_percentage_24h > 3 &&     // minimum momentum
        c.price_change_percentage_24h < 15 &&    // avoid overpump
        c.total_volume > 1000000                 // liquidity filter
    );

    if (filtered.length === 0) {
        console.log("⚠️ No valid setups");
        return;
    }

    // pick NOT top (avoid trap)
    const pick = filtered[1] || filtered[0];
    const symbol = pick.symbol.toUpperCase();

    // avoid duplicate trades
    if (activeTrades.find(t => t.symbol === symbol)) return;

    const tradeAmount = balance * TRADE_PERCENT;

    console.log(`🚀 ENTRY ${symbol} with ${tradeAmount}`);

    await placeOrder(symbol, "buy", tradeAmount);

    const entryPrice = await getPrice(symbol);

    // SAFE MEMORY STORE
    activeTrades.push({
        symbol,
        entryPrice,
        amount: tradeAmount
    });
};

// ---- ENGINE ----
const engine = async () => {
    try {
        console.log("🔍 SCAN START");

        await checkAndSell(); // exit first
        await findTrades();   // then entry

    } catch (err) {
        console.error("🔥 Engine Error:", err.message);
    }
};

// ---- LOOP ----
cron.schedule('*/2 * * * *', engine);

app.listen(process.env.PORT || 3000, () => {
    console.log("🚀 Smart Bot Running");
});
