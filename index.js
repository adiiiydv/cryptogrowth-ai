/**
 * APEX HEDGE v25.0 - ULTIMATE STABILITY BUILD
 * Fixes: Insufficient Funds, Mapping Failures, and Precision Rejections
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
    // Only use top-tier coins that have high liquidity to avoid mapping errors
    WATCHLIST: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'],
    ALLOCATION_PCT: 1.0, // Force 100% usage as requested
    TP: 2.0, 
    SL: 1.5,
    MIN_ORDER_USDT: 5.0 // The hard floor for CoinDCX/Binance pairs
};

let activeTrades = [];
if (fs.existsSync(STATE_FILE)) { 
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch(e) { activeTrades = []; }
}

const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
const sign = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(JSON.stringify(body)).digest('hex');

/**
 * FIX: REMOVE INVALID REQUESTS (Precision Engine)
 * Automatically rounds quantity to the exchange's allowed decimals
 */
function fixPrecision(qty, symbol) {
    if (symbol.includes('BTC')) return Number(Math.floor(qty * 1000000) / 1000000); // 6 Decimals
    if (symbol.includes('ETH')) return Number(Math.floor(qty * 100000) / 100000);   // 5 Decimals
    return Number(Math.floor(qty * 100) / 100); // 2 Decimals for others
}

/**
 * FIX: REMOVE MAPPING FAILURES
 * Dynamically finds the correct ticker name (e.g., B-BTC_USDT vs BTCUSDT)
 */
async function findCorrectMarket(symbol) {
    try {
        const coin = symbol.replace("USDT", "");
        const res = await axios.get('https://public.coindcx.com/exchange/ticker');
        const possibleNames = [`B-${coin}_USDT`, `${coin}USDT`, `${coin}_USDT` ];
        const market = res.data.find(m => possibleNames.includes(m.market));
        return market || null;
    } catch (e) { return null; }
}

async function placeOrder(side, symbol, amount, qtyOverride = null) {
    try {
        const mData = await findCorrectMarket(symbol);
        if (!mData) {
            log(`❌ MAPPING ERROR: Could not find ${symbol} on exchange.`);
            return null;
        }

        const price = Number(mData.last_price);
        // FIX: INSUFFICIENT FUNDS
        // We subtract a tiny 0.2% buffer from the 100% balance to pay the fee
        const effectiveAmount = amount * 0.998; 
        let qty = qtyOverride ? qtyOverride : (effectiveAmount / price);
        qty = fixPrecision(qty, symbol);

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
            log(`✅ ${side.toUpperCase()} SUCCESS: ${mData.market}`);
            return { price, qty, market: mData.market };
        }
        log(`❌ REJECTED: ${JSON.stringify(res.data)}`);
        return null;
    } catch (e) { 
        log(`❌ API ERROR: ${e.response?.data?.message || e.message}`);
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

        log(`--- HEARTBEAT | BAL: $${bal.toFixed(2)} | TRADES: ${activeTrades.length} ---`);

        // Stop if balance is too low for the $5 minimum
        if (bal < CONFIG.MIN_ORDER_USDT && activeTrades.length === 0) {
            log(`⚠️ Balance $${bal} below $5 limit. Deposit required.`);
            return;
        }

        for (const coin of CONFIG.WATCHLIST) {
            if (activeTrades.length > 0) break; 
            
            const cndl = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}&interval=1m&limit=30`).catch(() => null);
            if (!cndl) continue;

            const cls = cndl.data.map(c => Number(c[4]));
            const rsi = RSI.calculate({ values: cls, period: 14 }).pop();

            // Aggressive trigger to use your balance immediately
            if (rsi < 50) { 
                log(`🎯 SIGNAL: ${coin} RSI ${rsi.toFixed(1)}. Executing...`);
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

app.get('/', (req, res) => res.send("BOT ONLINE"));
app.listen(PORT, '0.0.0.0', () => {
    runScanner();
    cron.schedule('*/1 * * * *', runScanner);
});
