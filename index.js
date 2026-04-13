const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
let activeTrade = null;

// --- CONFIG ---
const WATCHLIST = ['SOL', 'BTC', 'ETH', 'DOGE', 'MATIC', 'ADA', 'XRP'];
const STOP_LOSS_PCT = 1.2;
const TAKE_PROFIT_PCT = 2.5;

const signDCX = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

async function getOhlcv(symbol) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1m&limit=50`);
        return res.data.map(d => parseFloat(d[4]));
    } catch (e) { return null; }
}

const runMultiScanner = async () => {
    if (activeTrade) {
        await checkExit(activeTrade);
        return;
    }

    // --- FETCH LIVE USDT BALANCE ---
    let currentUSDT = "0.00";
    try {
        const body = { timestamp: Date.now() };
        const balanceRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdtData = balanceRes.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        currentUSDT = usdtData ? parseFloat(usdtData.balance).toFixed(2) : "0.00";
    } catch (e) {
        currentUSDT = "Error";
    }

    console.log(`--- 🔍 SCAN | Wallet: ${currentUSDT} USDT | ${new Date().toLocaleTimeString()} ---`);

    for (const coin of WATCHLIST) {
        const prices = await getOhlcv(coin);
        if (!prices) continue;

        const rsi = RSI.calculate({ values: prices, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: prices, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: prices, period: 21 }).pop();
        const currentPrice = prices[prices.length - 1];

        console.log(`📡 [${coin}] P: ${currentPrice.toFixed(2)} | RSI: ${rsi.toFixed(2)} | EMA9: ${ema9.toFixed(2)}`);

        if (rsi < 30 && ema9 > ema21) {
            console.log(`🎯 SIGNAL for ${coin}!`);
            const bought = await executeOrder("buy", coin, (parseFloat(currentUSDT) * 0.98).toFixed(2));
            if (bought) {
                activeTrade = { symbol: coin, entry: bought.price, qty: bought.qty };
                break;
            }
        }
    }
};

async function checkExit(trade) {
    try {
        const prices = await getOhlcv(trade.symbol);
        const currentPrice = prices[prices.length - 1];
        const pnl = ((currentPrice - trade.entry) / trade.entry) * 100;
        console.log(`📈 Monitoring [${trade.symbol}] | PnL: ${pnl.toFixed(2)}%`);
        
        if (pnl >= TAKE_PROFIT_PCT || pnl <= -STOP_LOSS_PCT) {
            const sold = await executeOrder("sell", trade.symbol, (trade.qty * currentPrice).toFixed(2));
            if (sold) activeTrade = null;
        }
    } catch (e) { console.log("Exit Check Error"); }
}

async function executeOrder(side, symbol, amount) {
    try {
        const pRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        const price = parseFloat(pRes.data.price);
        const qty = (amount / price).toFixed(3);
        const body = { side, order_type: "market_order", market: `${symbol}USDT`, total_quantity: qty, timestamp: Date.now() };
        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        return { price, qty };
    } catch (err) {
        console.log(`❌ Order Failed: ${err.response?.data?.message || "Error"}`);
        return null;
    }
}

// --- KEEP-ALIVE SERVER (Stops the "Application exited early" error) ---
app.get('/', (req, res) => res.send('Bot status: Active 🚀'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server live on port ${PORT}`));

cron.schedule('*/1 * * * *', runMultiScanner);
