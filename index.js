/**
 * APEX HEDGE v24.0 - HYBRID PRECISION BUILD
 * Combines Safe Quantity Logic with Automated Scanning
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
    ALLOCATION_PCT: 0.95, // Leaves 5% for fees to prevent "Insufficient Funds"
    TP: 2.5, 
    SL: 1.5,
    MIN_ORDER_USDT: 5.05 // Safety floor to stay above exchange minimums
};

let activeTrades = [];
if (fs.existsSync(STATE_FILE)) { 
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch(e) { activeTrades = []; }
}

const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
const sign = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(JSON.stringify(body)).digest('hex');

// ================= PRECISION & SAFETY ENGINE =================
// Combined logic to fix "Invalid Request" and "Decimal" errors
function getSafeQty(amount, price, symbol) {
    let qty = amount / price;
    
    // Coin-specific rounding rules to prevent Status 400
    if (symbol.includes('BTC')) qty = Number(qty.toFixed(6));
    else if (symbol.includes('ETH')) qty = Number(qty.toFixed(5));
    else if (symbol.includes('DOGE')) qty = Math.floor(qty); // DOGE must be whole numbers
    else qty = Number(qty.toFixed(2));

    // Final check: Is the order value still above $5.00?
    if (qty * price < 5.00) return { error: "QTY_TOO_LOW_FOR_MIN_ORDER", qty: 0 };
    return { error: null, qty };
}

async function getMarket(symbol) {
    try {
        const coin = symbol.replace("USDT", "");
        const res = await axios.get('https://public.coindcx.com/exchange/ticker');
        // Support for multiple naming conventions to fix "Mapping Errors"
        const names = [`B-${coin}_USDT`, `${coin}USDT`, `${coin}_USDT` ];
        return res.data.find(m => names.includes(m.market)) || null;
    } catch (e) { return null; }
}

async function placeOrder(side, symbol, amount, qtyOverride = null) {
    try {
        const mData = await getMarket(symbol);
        if (!mData) return null;

        const price = Number(mData.last_price);
        let qtyResult = qtyOverride ? { qty: qtyOverride } : getSafeQty(amount, price, symbol);

        if (qtyResult.error) {
            log(`⚠️ SKIPPING: ${symbol} - ${qtyResult.error}`);
            return null;
        }

        const body = {
            side,
            order_type: "market_order",
            market: mData.market,
            total_quantity: qtyResult.qty,
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
            log(`✅ ${side.toUpperCase()} SUCCESS: ${mData.market} | Qty: ${qtyResult.qty}`);
            return { price, qty: qtyResult.qty, market: mData.market };
        }
        log(`❌ EXCH REJECTED: ${JSON.stringify(res.data)}`);
        return null;
    } catch (e) { 
        log(`❌ API ERROR: ${e.response?.data?.message || e.message}`);
        return null; 
    }
}

// ================= SCANNER ENGINE =================
async function runScanner() {
    try {
        // Fetch fresh balance
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', {timestamp: Date.now()}, {
            headers: { "X-AUTH-APIKEY": process.env.COINDCX_API_KEY, "X-AUTH-SIGNATURE": sign({timestamp: Date.now()}) }
        });
        const usdt = bRes.data?.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        const bal = Number(usdt?.balance || usdt?.available_balance || 0);

        log(`--- HEARTBEAT | BAL: $${bal.toFixed(2)} | ACTIVE: ${activeTrades.length} ---`);

        // Check for exits first
        const ticker = await axios.get('https://public.coindcx.com/exchange/ticker');
        for (let i = activeTrades.length - 1; i >= 0; i--) {
            const t = activeTrades[i];
            const m = ticker.data.find(x => x.market === t.market);
            if (!m) continue;
            const pnl = ((Number(m.last_price) - t.entry) / t.entry) * 100;
            if (pnl >= CONFIG.TP || pnl <= -CONFIG.SL) {
                const sold = await placeOrder("sell", t.symbol, 0, t.qty);
                if (sold) { activeTrades.splice(i, 1); fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades)); }
            }
        }

        // Search for entries if balance is sufficient
        if (bal < CONFIG.MIN_ORDER_USDT && activeTrades.length === 0) return;

        for (const coin of CONFIG.WATCHLIST) {
            if (activeTrades.length > 0) break; // Stick to one trade with a $5 balance
            
            const cndl = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}&interval=1m&limit=50`).catch(() => null);
            if (!cndl) continue;

            const cls = cndl.data.map(c => Number(c[4]));
            const rsi = RSI.calculate({ values: cls, period: 14 }).pop();
            const e9 = EMA.calculate({ values: cls, period: 9 }).pop();
            const e21 = EMA.calculate({ values: cls, period: 21 }).pop();

            // Aggressive trigger for testing: EMA Cross
            if (e9 > e21 || rsi < 40) {
                log(`🎯 SIGNAL: ${coin} (RSI: ${rsi.toFixed(1)})`);
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

app.get('/', (req, res) => res.send("APEX HYBRID ACTIVE"));
app.listen(PORT, '0.0.0.0', () => {
    log(`🚀 FINAL DEPLOY ON PORT ${PORT}`);
    runScanner();
    cron.schedule('*/1 * * * *', runScanner);
});
