/**
 * APEX HEDGE v23.0 - STABLE EXECUTION BUILD
 * Fixes: "Insufficient funds" 400 Errors & Precision
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = './state.json';

const CONFIG = {
    WATCHLIST: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT'],
    // CRITICAL FIX: Lowered to 95% to ensure fees are covered
    ALLOCATION_PCT: 0.95, 
    TP: 2.0, 
    SL: 1.5,
    MIN_VAL: 5.05 
};

let activeTrades = [];
if (fs.existsSync(STATE_FILE)) { 
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch(e) { activeTrades = []; }
}

const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
const sign = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(JSON.stringify(body)).digest('hex');

// Precision fix to stop "Invalid Request" errors
function formatQty(qty, symbol) {
    if (symbol.includes('BTC')) return Number(qty.toFixed(6));
    if (symbol.includes('ETH')) return Number(qty.toFixed(5));
    if (symbol.includes('DOGE')) return Number(qty.toFixed(0)); // DOGE must be whole numbers
    return Number(qty.toFixed(2));
}

async function getMarket(symbol) {
    try {
        const coin = symbol.replace("USDT", "");
        const res = await axios.get('https://public.coindcx.com/exchange/ticker');
        const names = [`B-${coin}_USDT`, `${coin}USDT`, `${coin}_USDT` ];
        return res.data.find(m => names.includes(m.market)) || null;
    } catch (e) { return null; }
}

async function placeOrder(side, symbol, amount, qtyOverride = null) {
    try {
        const mData = await getMarket(symbol);
        if (!mData) return null;

        const price = Number(mData.last_price);
        let qty = qtyOverride ? qtyOverride : (amount / price);
        qty = formatQty(qty, symbol);

        const body = {
            side,
            order_type: "market_order",
            market: mData.market,
            total_quantity: qty,
            timestamp: Date.now()
        };

        const res = await axios.post("https://api.coindcx.com/exchange/v1/orders/create", body, {
            headers: { 
                "X-AUTH-APIKEY": process.env.COINDCX_API_KEY, 
                "X-AUTH-SIGNATURE": sign(body),
                "Content-Type": "application/json"
            }
        });

        if (res.data && res.data.status !== "error") {
            log(`✅ ${side.toUpperCase()} SUCCESS: ${mData.market} Qty: ${qty}`);
            return { price, qty, market: mData.market };
        }
        
        // This will now print the EXACT reason if it fails
        log(`❌ EXCH REJECTED: ${JSON.stringify(res.data)}`);
        return null;
    } catch (e) { 
        log(`❌ API ERROR: ${JSON.stringify(e.response?.data || e.message)}`);
        return null; 
    }
}

async function runScanner() {
    try {
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', {timestamp: Date.now()}, {
            headers: { "X-AUTH-APIKEY": process.env.COINDCX_API_KEY, "X-AUTH-SIGNATURE": sign({timestamp: Date.now()}) }
        });
        const usdt = bRes.data?.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        const bal = Number(usdt?.balance || usdt?.available_balance || 0);

        log(`--- SCAN | BAL: $${bal.toFixed(2)} | ACTIVE: ${activeTrades.length} ---`);

        // If your balance drops below $5.00 due to fees, the bot will stop to prevent errors
        if (bal < 5.00 && activeTrades.length === 0) {
            log("⚠️ Balance too low for minimum $5 order. Add funds or wait.");
            return;
        }

        for (const coin of CONFIG.WATCHLIST) {
            if (activeTrades.length > 0) break; // Only 1 trade at a time for this balance
            
            const cndl = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}&interval=1m&limit=50`).catch(() => null);
            if (!cndl) continue;

            const cls = cndl.data.map(c => Number(c[4]));
            const rsi = RSI.calculate({ values: cls, period: 14 }).pop();
            const e9 = EMA.calculate({ values: cls, period: 9 }).pop();
            const e21 = EMA.calculate({ values: cls, period: 21 }).pop();

            if (rsi < 35 || e9 > e21) {
                log(`🎯 ATTEMPTING BUY: ${coin}`);
                // Uses 95% of balance to leave room for fees
                const buy = await placeOrder("buy", coin, bal * CONFIG.ALLOCATION_PCT);
                if (buy) {
                    activeTrades.push({ symbol: coin, market: buy.market, entry: buy.price, qty: buy.qty });
                    fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
                    break; 
                }
            }
        }
    } catch (e) { log(`System Error: ${e.message}`); }
}

app.get('/', (req, res) => res.send("BOT RUNNING"));
app.listen(PORT, '0.0.0.0', () => {
    runScanner();
    cron.schedule('*/1 * * * *', runScanner);
});
