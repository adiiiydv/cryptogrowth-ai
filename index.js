const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 1. START SERVER FIRST (Fixes Render "Exited Early" Error)
app.get('/', (req, res) => res.send('Apex Bot is Active 🚀'));
app.listen(PORT, () => console.log(`✅ Server live on port ${PORT}`));

// --- CONFIG ---
let WATCHLIST = ['SOL', 'BTC', 'ETH', 'DOGE', 'MATIC', 'ADA', 'XRP'];
let activeTrade = null;

const signDCX = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

// 2. STABLE RESEARCH (Doesn't crash the bot)
async function researchNewPotential() {
    try {
        const res = await axios.get('https://api.binance.com/api/v3/ticker/24hr', { timeout: 5000 });
        const gems = res.data
            .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.quoteVolume) > 20000000)
            .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent))
            .slice(0, 3)
            .map(t => t.symbol.replace('USDT', ''));
        
        WATCHLIST = ['SOL', 'BTC', 'ETH', 'DOGE', 'MATIC', 'ADA', 'XRP', ...gems];
        console.log(`🕵️ Research: New Gems Added: ${gems.join(', ')}`);
    } catch (e) {
        console.log("⚠️ Research skipped: Binance API Busy");
    }
}

async function getOhlcv(symbol) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1m&limit=50`, { timeout: 5000 });
        return res.data.map(d => parseFloat(d[4]));
    } catch (e) { return null; }
}

const runMultiScanner = async () => {
    if (activeTrade) {
        await checkExit(activeTrade);
        return;
    }

    let currentUSDT = "0.00";
    try {
        const body = { timestamp: Date.now() };
        const balRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) },
            timeout: 5000
        });
        const usdtData = balRes.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        currentUSDT = usdtData ? parseFloat(usdtData.balance).toFixed(2) : "0.00";
    } catch (e) { currentUSDT = "4.01"; } // Use your known balance as fallback

    console.log(`--- 🔍 SCAN | Wallet: ${currentUSDT} USDT | Time: ${new Date().toLocaleTimeString()} ---`);

    for (const coin of WATCHLIST) {
        const prices = await getOhlcv(coin);
        if (!prices || prices.length < 21) continue;

        const rsi = RSI.calculate({ values: prices, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: prices, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: prices, period: 21 }).pop();
        const currentPrice = prices[prices.length - 1];

        console.log(`📡 [${coin}] P: ${currentPrice.toFixed(2)} | RSI: ${rsi.toFixed(2)} | EMA9: ${ema9.toFixed(2)}`);

        if (rsi < 30 && ema9 > ema21) {
            console.log(`🎯 SIGNAL for ${coin}! Investing...`);
            const bought = await executeOrder("buy", coin, (parseFloat(currentUSDT) * 0.98).toFixed(2));
            if (bought) {
                activeTrade = { symbol: coin, entry: bought.price, qty: bought.qty };
                break;
            }
        }
    }
};

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
        console.log(`❌ Order Failed for ${symbol}`);
        return null;
    }
}

// 3. SCHEDULES (Lightweight)
cron.schedule('*/1 * * * *', runMultiScanner);
cron.schedule('0 * * * *', researchNewPotential);
