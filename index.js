const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
let activeTrade = null; 

// --- UPGRADED CONFIG ---
const SYMBOL = 'SOL'; 
const STOP_LOSS_PCT = 1.2;    // Tighter stop loss to protect ₹100 capital
const TAKE_PROFIT_PCT = 2.5;  // Real-world scalping target
const TRAILING_OFFSET = 0.5;  // Trailing profit protection

const signDCX = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(payload).digest('hex');
};

// --- NEW: COMPOUNDING ENGINE ---
// This automatically uses your growing balance for the next trade
async function getCompoundAmount() {
    try {
        const body = { timestamp: Date.now() };
        const res = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdt = res.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        const balance = parseFloat(usdt.balance);
        return (balance * 0.98).toFixed(2); // Use 98% of balance (leaves 2% for fees/TDS)
    } catch (e) { return 1.87; }
}

const runApexEngine = async () => {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}USDT&interval=1m&limit=100`);
        const prices = res.data.map(d => parseFloat(d[4]));
        
        const rsi = RSI.calculate({ values: prices, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: prices, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: prices, period: 21 }).pop();
        const currentPrice = prices[prices.length - 1];

        console.log(`🤖 [APEX] ${SYMBOL}: ${currentPrice} | RSI: ${rsi.toFixed(2)} | EMA9: ${ema9.toFixed(2)}`);

        // --- UPGRADED BUY LOGIC (Trend Confirmation) ---
        if (!activeTrade && rsi < 32 && ema9 > ema21) {
            const amount = await getCompoundAmount();
            console.log(`🚀 SIGNAL: RSI Oversold + EMA Cross. Buying with ${amount} USDT...`);
            
            const bought = await executeOrder("buy", SYMBOL, amount);
            if (bought) {
                activeTrade = { 
                    symbol: SYMBOL, 
                    entry: bought.price, 
                    qty: bought.qty, 
                    highestPrice: bought.price 
                };
            }
        }

        // --- UPGRADED SELL LOGIC (Trailing Stop) ---
        if (activeTrade) {
            const pnl = ((currentPrice - activeTrade.entry) / activeTrade.entry) * 100;
            
            // Track highest price for trailing stop
            if (currentPrice > activeTrade.highestPrice) activeTrade.highestPrice = currentPrice;
            const dropFromPeak = ((activeTrade.highestPrice - currentPrice) / activeTrade.highestPrice) * 100;

            // Exit conditions: Target hit + Trailing, Stop Loss, or Indicator Flip
            const exitSignal = (pnl >= TAKE_PROFIT_PCT && dropFromPeak >= TRAILING_OFFSET) || 
                               (pnl <= -STOP_LOSS_PCT) || 
                               (rsi > 75);

            if (exitSignal) {
                console.log(`💰 EXIT: Closing with ${pnl.toFixed(2)}% PnL`);
                const sold = await executeOrder("sell", SYMBOL, (activeTrade.qty * currentPrice).toFixed(2));
                if (sold) activeTrade = null;
            }
        }
    } catch (err) { console.log("Engine Pause:", err.message); }
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
        console.log(`❌ Order Blocked: ${err.response?.data?.message || "Check Balance"}`);
        return null;
    }
}

cron.schedule('*/1 * * * *', runApexEngine);
app.listen(process.env.PORT || 3000);
