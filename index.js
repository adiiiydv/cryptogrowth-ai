const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// 1. STABILITY SIGNAL
app.get('/', (req, res) => res.send('Apex Pro Bot: Active 🚀'));
app.listen(PORT, () => console.log(`✅ System Live on Port ${PORT}`));

const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

// --- CONFIG ---
let WATCHLIST = ['SOL', 'BTC', 'ETH', 'DOGE', 'MATIC', 'ADA', 'XRP'];
let activeTrade = null;

const signDCX = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

// 2. SCANNER (Bias Removed + Trend Confirmation)
const runMultiScanner = async () => {
    if (activeTrade) {
        await checkTrailingExit(activeTrade);
        return;
    }

    // Shuffle Watchlist to remove "First Coin Bias"
    const shuffledList = [...WATCHLIST].sort(() => Math.random() - 0.5);
    
    // Fetch live balance for Compounding
    let balance = 4.01; 
    try {
        const body = { timestamp: Date.now() };
        const balRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdtData = balRes.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        balance = usdtData ? parseFloat(usdtData.balance) : balance;
    } catch (e) { /* use fallback */ }

    console.log(`--- 🔍 SCAN | Wallet: ${balance.toFixed(2)} USDT | ${new Date().toLocaleTimeString()} ---`);

    for (const coin of shuffledList) {
        try {
            const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=1m&limit=50`);
            const prices = res.data.map(d => parseFloat(d[4]));
            
            const rsi = RSI.calculate({ values: prices, period: 14 }).pop();
            const ema9 = EMA.calculate({ values: prices, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: prices, period: 21 }).pop();

            // BETTER SIGNAL: RSI < 35 + EMA Trend Confirmation
            if (rsi < 35 && ema9 > ema21) {
                console.log(`🎯 SIGNAL: ${coin} RSI:${rsi.toFixed(2)} | Trend: UP`);
                
                // COMPOUNDING: Use 95% of current balance for trade
                const tradeAmount = (balance * 0.95).toFixed(2);
                
                const bought = await executeOrder("buy", coin, tradeAmount);
                if (bought) {
                    activeTrade = { 
                        symbol: coin, 
                        entry: bought.price, 
                        qty: bought.qty, 
                        highestPrice: bought.price // For Trailing Profit
                    };
                    break;
                }
            }
        } catch (e) { continue; }
    }
};

// 3. TRAILING PROFIT LOGIC
async function checkTrailingExit(trade) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${trade.symbol}USDT`);
        const currentPrice = parseFloat(res.data.price);
        
        // Update high point for trailing
        if (currentPrice > trade.highestPrice) {
            trade.highestPrice = currentPrice;
            console.log(`🔥 Trailing Up: ${trade.symbol} New High: ${trade.highestPrice}`);
        }

        const dropFromTop = ((trade.highestPrice - currentPrice) / trade.highestPrice) * 100;
        const totalGain = ((currentPrice - trade.entry) / trade.entry) * 100;

        // EXIT LOGIC: 
        // 1. If up 1.5%, sell if price drops 0.5% from the top (Trailing)
        // 2. Strict Stop Loss at -1.2%
        if ((totalGain > 1.5 && dropFromTop > 0.5) || totalGain <= -1.2) {
            console.log(`🚪 EXITING: ${trade.symbol} | Gain: ${totalGain.toFixed(2)}%`);
            const sold = await executeOrder("sell", trade.symbol, (trade.qty * currentPrice).toFixed(2));
            if (sold) activeTrade = null;
        }
    } catch (e) { console.log("Exit check failed"); }
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
        console.log(`❌ Order Failed: ${err.response?.data?.message}`);
        return null;
    }
}

cron.schedule('*/1 * * * *', runMultiScanner);
