const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
let activeTrade = null; 

// --- CONFIG ---
const SYMBOL = 'SOL'; // Recommended for small balances
const TRADE_AMOUNT = 1.87; // Optimized for 1.92 USDT balance (leaves room for 1% TDS/Fees)
const STOP_LOSS_PCT = 1.5;
const TAKE_PROFIT_PCT = 3.0;

const signDCX = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

// 1. Fetch Historical Data (Binance is faster for OHLCV)
async function getOhlcv(symbol) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1m&limit=50`);
        return res.data.map(d => parseFloat(d[4])); // Closing Prices
    } catch (e) { return []; }
}

// 2. CoinDCX Order Execution
async function executeOrder(side, symbol, amount) {
    try {
        const priceRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        const price = parseFloat(priceRes.data.price);
        const qty = (amount / price).toFixed(4); // Precision matters for micro-caps

        const body = {
            side,
            order_type: "market_order",
            market: `${symbol}USDT`,
            total_quantity: qty,
            timestamp: Date.now()
        };

        const res = await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        
        console.log(`🚀 ${side.toUpperCase()} EXECUTED: ${symbol} at ${price}`);
        return { price, qty };
    } catch (err) {
        console.log(`❌ Order Failed: ${err.response?.data?.message || err.message}`);
        return null;
    }
}

// 3. Strategy Engine
const runBot = async () => {
    console.log("🔍 Running Indicator Scan...");
    const prices = await getOhlcv(SYMBOL);
    if (prices.length < 30) return;

    // Calculate Indicators
    const rsi = RSI.calculate({ values: prices, period: 14 }).pop();
    const ema9 = EMA.calculate({ values: prices, period: 9 }).pop();
    const ema21 = EMA.calculate({ values: prices, period: 21 }).pop();
    const currentPrice = prices[prices.length - 1];

    console.log(`[${SYMBOL}] Price: ${currentPrice} | RSI: ${rsi.toFixed(2)} | EMA9: ${ema9.toFixed(2)} | EMA21: ${ema21.toFixed(2)}`);

    // --- BUY LOGIC: RSI Oversold + EMA Crossover ---
    if (!activeTrade && rsi < 35 && ema9 > ema21) {
        console.log("🔥 CRITERIA MET: Snipping Entry...");
        const bought = await executeOrder("buy", SYMBOL, TRADE_AMOUNT);
        if (bought) activeTrade = { symbol: SYMBOL, entry: bought.price, qty: bought.qty };
    }

    // --- SELL LOGIC: RSI Overbought OR EMA Cross Down OR Risk Mgmt ---
    if (activeTrade) {
        const pnl = ((currentPrice - activeTrade.entry) / activeTrade.entry) * 100;
        
        const shouldSell = rsi > 70 || ema9 < ema21 || pnl >= TAKE_PROFIT_PCT || pnl <= -STOP_LOSS_PCT;

        if (shouldSell) {
            console.log(`💰 EXIT SIGNAL: Closing Position with ${pnl.toFixed(2)}% PnL`);
            const sold = await executeOrder("sell", SYMBOL, TRADE_AMOUNT);
            if (sold) activeTrade = null;
        }
    }
};

// Scalp every 1 minute
cron.schedule('*/1 * * * *', runBot);

app.get('/', (req, res) => res.json({ status: "BOT_LIVE", monitoring: SYMBOL, position: activeTrade }));
app.listen(process.env.PORT || 3000);
