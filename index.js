/**
 * APEX HEDGE v27.0 - HYBRID MICRO-BALANCE BUILD
 * Optimized for balances between $5.05 and $5.50
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = './state.json';

const CONFIG = {
    // Limited watchlist to ensure the $5.10 is used on high-liquidity pairs
    WATCHLIST: ['BTCUSDT', 'ETHUSDT'],
    // 0.992 is the mathematical fix for $5.10 balance
    // ($5.10 * 0.992 = $5.05) -> Above $5 limit AND covers fees.
    ALLOCATION_PCT: 0.992, 
    MIN_ORDER_USDT: 5.01,
    TP: 1.5,
    SL: 1.2
};

let activeTrades = [];
if (fs.existsSync(STATE_FILE)) { 
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch(e) { activeTrades = []; }
}

const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
const sign = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(JSON.stringify(body)).digest('hex');

/**
 * BUG FIX: INVALID REQUESTS
 * Hard-coded precision to meet exchange requirements exactly.
 */
function fixPrecision(qty, symbol) {
    if (symbol.includes('BTC')) return Number(Math.floor(qty * 1000000) / 1000000); 
    if (symbol.includes('ETH')) return Number(Math.floor(qty * 100000) / 100000);   
    return Number(Math.floor(qty * 100) / 100); 
}

/**
 * BUG FIX: MAPPING FAILURES
 * Scans the ticker to find the correct naming convention.
 */
async function findCorrectMarket(symbol) {
    try {
        const coin = symbol.replace("USDT", "");
        const res = await axios.get('https://public.coindcx.com/exchange/ticker');
        const names = [`B-${coin}_USDT`, `${coin}USDT`, `${coin}_USDT` ];
        return res.data.find(m => names.includes(m.market)) || null;
    } catch (e) { return null; }
}

async function placeOrder(side, symbol, amount, qtyOverride = null) {
    try {
        const mData = await findCorrectMarket(symbol);
        if (!mData) return null;

        const price = Number(mData.last_price);
        let qty = qtyOverride ? qtyOverride : (amount / price);
        qty = fixPrecision(qty, symbol);

        // Safety check to prevent 400 errors
        if (qty * price < 5.00) {
            log(`⚠️ ORDER BLOCKED: $${(qty * price).toFixed(2)} is below exchange minimum.`);
            return null;
        }

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
            log(`✅ ${side.toUpperCase()} SUCCESS: ${mData.market} @ ${price}`);
            return { price, qty, market: mData.market };
        }
        log(`❌ EXCH REJECT: ${JSON.stringify(res.data)}`);
        return null;
    } catch (e) { 
        log(`❌ API CRITICAL: ${e.response?.data?.message || e.message}`);
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

        // Handle Active Trades (Take Profit / Stop Loss)
        if (activeTrades.length > 0) {
            const ticker = await axios.get('https://public.coindcx.com/exchange/ticker');
            for (let i = activeTrades.length - 1; i >= 0; i--) {
                const t = activeTrades[i];
                const current = ticker.data.find(m => m.market === t.market);
                if (!current) continue;

                const pnl = ((Number(current.last_price) - t.entry) / t.entry) * 100;
                if (pnl >= CONFIG.TP || pnl <= -CONFIG.SL) {
                    log(`🔔 EXIT SIGNAL: PNL ${pnl.toFixed(2)}%`);
                    const sold = await placeOrder("sell", t.symbol, 0, t.qty);
                    if (sold) { activeTrades.splice(i, 1); fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades)); }
                }
            }
            return; // Stay in the trade, don't buy more
        }

        // Buy Logic
        if (bal < CONFIG.MIN_ORDER_USDT) return;

        for (const coin of CONFIG.WATCHLIST) {
            const cndl = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}&interval=1m&limit=30`).catch(() => null);
            if (!cndl) continue;

            const cls = cndl.data.map(c => Number(c[4]));
            const rsi = RSI.calculate({ values: cls, period: 14 }).pop();

            if (rsi < 45) { // Entry trigger
                log(`🎯 SIGNAL: ${coin} RSI ${rsi.toFixed(1)}`);
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

app.get('/', (req, res) => res.send("APEX v27 ONLINE"));
app.listen(PORT, '0.0.0.0', () => {
    runScanner();
    cron.schedule('*/1 * * * *', runScanner);
});
