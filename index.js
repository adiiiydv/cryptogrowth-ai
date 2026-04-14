/**
 * APEX HEDGE v18.5 - ZERO-ERROR PRODUCTION BUILD
 * Fixes: Port Binding, 404 Mapping, and Status 400 Rejections
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
// RENDER FIX: Must listen on 0.0.0.0 and use process.env.PORT
const PORT = process.env.PORT || 3000;

const STATE_FILE = './state.json';
const CONFIG = {
    WATCHLIST: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'MATICUSDT', 'DOGEUSDT'],
    ALLOCATION_PCT: 0.70, // Trades with 70% of available USDT
    TP: 2.5, 
    SL: 1.5,
    MIN_USDT: 2.0 // Ensures we don't try to trade dust
};

let activeTrades = [];
if (fs.existsSync(STATE_FILE)) { 
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch(e) { activeTrades = []; }
}

const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
const sign = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(JSON.stringify(body)).digest('hex');

// --- MARKET MAPPING ENGINE ---
async function getCorrectMarket(symbol) {
    try {
        const coin = symbol.replace("USDT", "");
        const res = await axios.get('https://public.coindcx.com/exchange/ticker', { timeout: 10000 });
        if (!res.data || !Array.isArray(res.data)) return null;

        // Try every possible naming convention CoinDCX uses
        const possibilities = [`${coin}USDT`, `B-${coin}_USDT`, `${coin}_USDT`, `B-${coin}USDT`];
        
        for (let name of possibilities) {
            const match = res.data.find(m => m.market === name);
            if (match) return match;
        }
        return null;
    } catch (e) { return null; }
}

// --- ORDER ENGINE ---
async function placeOrder(side, symbol, amount, qtyOverride = null) {
    try {
        const marketData = await getCorrectMarket(symbol);
        if (!marketData) {
            log(`❌ MAPPING ERROR: ${symbol} pair not found on ticker.`);
            return null;
        }

        const price = Number(marketData.last_price);
        // Rounding quantity strictly to 5 decimals to prevent Status 400
        const qty = qtyOverride ? Number(qtyOverride.toFixed(5)) : Number((amount / price).toFixed(5));

        const body = {
            side,
            order_type: "market_order",
            market: marketData.market,
            total_quantity: qty,
            timestamp: Date.now()
        };

        const res = await axios.post("https://api.coindcx.com/exchange/v1/orders/create", body, {
            headers: {
                "X-AUTH-APIKEY": process.env.COINDCX_API_KEY,
                "X-AUTH-SIGNATURE": sign(body),
                "Content-Type": "application/json"
            },
            timeout: 15000
        });

        if (res.data && res.data.status !== "error") {
            log(`✅ ${side.toUpperCase()} ${marketData.market} success at ${price}`);
            return { price, qty, market: marketData.market };
        }
        log(`❌ REJECTED: ${res.data.message}`);
        return null;
    } catch (e) {
        log(`❌ API CRITICAL: ${e.response?.status || 'ERR'} - ${e.message}`);
        return null;
    }
}

// --- SCANNER ENGINE ---
async function runScanner() {
    log("--- HEARTBEAT: SCANNING ---");
    try {
        // Step 1: Sync Balance
        const bBody = { timestamp: Date.now() };
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', bBody, {
            headers: { "X-AUTH-APIKEY": process.env.COINDCX_API_KEY, "X-AUTH-SIGNATURE": sign(bBody) }
        });
        const usdt = bRes.data?.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        const bal = Number(usdt?.balance || usdt?.available_balance || 0);

        // Step 2: Monitor Exits
        const ticker = await axios.get('https://public.coindcx.com/exchange/ticker');
        for (let i = activeTrades.length - 1; i >= 0; i--) {
            const t = activeTrades[i];
            const m = ticker.data.find(x => x.market === t.market);
            if (!m) continue;

            const pnl = ((Number(m.last_price) - t.entry) / t.entry) * 100;
            log(`📊 ${t.symbol}: ${pnl.toFixed(2)}%`);

            if (pnl >= CONFIG.TP || pnl <= -CONFIG.SL) {
                const sold = await placeOrder("sell", t.symbol, 0, t.qty);
                if (sold) {
                    activeTrades.splice(i, 1);
                    fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
                }
            }
        }

        // Step 3: Check for Entries
        for (const coin of CONFIG.WATCHLIST) {
            if (activeTrades.some(t => t.symbol === coin)) continue;

            const candles = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}&interval=1m&limit=40`);
            const closes = candles.data.map(c => Number(c[4]));
            
            const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
            const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();

            if (rsi < 60 && ema9 > ema21) {
                const tradeAmt = bal * CONFIG.ALLOCATION_PCT;
                if (tradeAmt > CONFIG.MIN_USDT) {
                    const buy = await placeOrder("buy", coin, tradeAmt);
                    if (buy) {
                        activeTrades.push({ symbol: coin, market: buy.market, entry: buy.price, qty: buy.qty });
                        fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
                    }
                }
            }
        }
    } catch (e) { log(`Scanner Error: ${e.message}`); }
}

// --- SERVER BOOT (RENDER KEEP-ALIVE) ---
app.get('/', (req, res) => res.status(200).send("BOT IS ACTIVE AND RUNNING"));

app.listen(PORT, '0.0.0.0', () => {
    log(`🚀 SERVER RUNNING ON PORT ${PORT}`);
    runScanner();
    cron.schedule('*/1 * * * *', runScanner);
});
