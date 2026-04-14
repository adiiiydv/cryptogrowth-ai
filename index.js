/**
 * APEX HEDGE v18.1 - RENDER OPTIMIZED PRODUCTION BUILD
 * Features: Fuzzy Mapping, Atomic State, Concurrency Guard, Port Binding Fix
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
// RENDER FIX: Ensure the bot binds to 0.0.0.0 and the assigned PORT
const PORT = process.env.PORT || 3000;

// --- 1. CONFIGURATION ---
const CONFIG = {
    STATE_FILE: './state.json',
    WATCHLIST: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'MATICUSDT'],
    ALLOCATION_PCT: 0.70,
    TP: 2.5,
    SL: 1.5,
    MIN_TRADE_USDT: 2.0,
    MARKET_CACHE_TTL: 60000 
};

let activeTrades = [];
let lastKnownBal = 0;
let isRunning = false;
let marketCache = { data: null, timestamp: 0 };

// Safe State Recovery
if (fs.existsSync(CONFIG.STATE_FILE)) {
    try {
        activeTrades = JSON.parse(fs.readFileSync(CONFIG.STATE_FILE));
    } catch (e) {
        console.error("⚠️ State corrupted. Resetting.");
        activeTrades = [];
    }
}

// --- 2. UTILITIES & SECURITY ---
const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);

const sign = (body) => 
    crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY)
        .update(JSON.stringify(body))
        .digest('hex');

/**
 * Enhanced Network Request with Retry logic
 */
async function safeGet(url, timeout = 25000, retries = 2) {
    try {
        const res = await axios.get(url, { timeout });
        return res?.data || null;
    } catch (e) {
        if (retries > 0) {
            await new Promise(r => setTimeout(r, 2000));
            return safeGet(url, timeout, retries - 1);
        }
        return null;
    }
}

// --- 3. MARKET ENGINE ---
async function getMarkets() {
    const now = Date.now();
    if (marketCache.data && (now - marketCache.timestamp < CONFIG.MARKET_CACHE_TTL)) {
        return marketCache.data;
    }
    const data = await safeGet('https://public.coindcx.com/exchange/ticker');
    if (Array.isArray(data)) {
        marketCache = { data, timestamp: now };
    }
    return marketCache.data || [];
}

/**
 * Order Engine with Fuzzy Mapping & 400/404 Protection
 */
async function placeOrder(side, symbol, amount, qtyOverride = null) {
    try {
        const coin = symbol.replace("USDT", "");
        const markets = await getMarkets();
        
        // FUZZY MAPPING: Handles CoinDCX naming variations
        const market = markets.find(m => 
            m.market === `${coin}USDT` || 
            m.market === `B-${coin}_USDT` || 
            m.market === `${coin}_USDT`
        );

        if (!market?.last_price) {
            log(`❌ MAPPING ERROR: ${symbol} not found on exchange.`);
            return null;
        }

        const price = Number(market.last_price);
        // QUANTITY FIX: Avoid 400 errors by rounding to valid decimals
        const qty = qtyOverride ? Number(qtyOverride.toFixed(5)) : Number((amount / price).toFixed(5));

        const body = {
            side,
            order_type: "market_order",
            market: market.market,
            total_quantity: qty,
            timestamp: Date.now()
        };

        log(`🔄 Executing ${side.toUpperCase()} ${market.market}...`);

        const res = await axios.post("https://api.coindcx.com/exchange/v1/orders/create", body, {
            headers: {
                "X-AUTH-APIKEY": process.env.COINDCX_API_KEY,
                "X-AUTH-SIGNATURE": sign(body),
                "Content-Type": "application/json"
            },
            timeout: 30000
        });

        if (res.data && res.data.status !== "error") {
            log(`✅ SUCCESS: ${market.market} @ ${price}`);
            return { price, qty, market: market.market };
        }

        log(`❌ REJECTION: ${res.data?.message || "Verify Balance/Keys"}`);
        return null;
    } catch (e) {
        log(`❌ API CRITICAL: ${e.response?.status || 'ERR'} - ${e.message}`);
        return null;
    }
}

// --- 4. ANALYTIC SCANNER ---
async function runScanner() {
    if (isRunning) return; 
    isRunning = true;

    try {
        // Step 1: Sync Balance
        const bBody = { timestamp: Date.now() };
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', bBody, {
            headers: { "X-AUTH-APIKEY": process.env.COINDCX_API_KEY, "X-AUTH-SIGNATURE": sign(bBody) },
            timeout: 20000
        }).catch(() => null);
        
        const usdt = bRes?.data?.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = Number(usdt?.balance || usdt?.available_balance || 0);

        log(`--- SCAN | BAL: $${lastKnownBal.toFixed(2)} | ACTIVE: ${activeTrades.length} ---`);

        const markets = await getMarkets();
        if (!markets.length) throw new Error("Ticker Down");

        // Step 2: Exit Logic (TP/SL)
        for (let i = activeTrades.length - 1; i >= 0; i--) {
            const t = activeTrades[i];
            const m = markets.find(x => x.market === t.market);
            if (!m) continue;

            const pnl = ((Number(m.last_price) - t.entry) / t.entry) * 100;
            log(`📈 ${t.symbol} PNL: ${pnl.toFixed(2)}%`);

            if (pnl <= -CONFIG.SL || pnl >= CONFIG.TP) {
                log(`🚨 EXIT SIGNAL: ${t.symbol}`);
                const sold = await placeOrder("sell", t.symbol, 0, t.qty);
                if (sold) {
                    activeTrades.splice(i, 1);
                    fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(activeTrades, null, 2));
                }
            }
        }

        // Step 3: Entry Logic
        for (const coin of CONFIG.WATCHLIST) {
            if (activeTrades.some(t => t.symbol === coin)) continue;

            const candles = await safeGet(`https://api.binance.com/api/v3/klines?symbol=${coin}&interval=1m&limit=40`);
            if (!Array.isArray(candles) || candles.length < 30) continue;

            const closes = candles.map(c => Number(c[4]));
            const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
            const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();

            if (rsi < 60 && ema9 > ema21) {
                const tradeAmt = lastKnownBal * CONFIG.ALLOCATION_PCT;
                if (tradeAmt > CONFIG.MIN_TRADE_USDT) {
                    log(`🎯 BUY SIGNAL: ${coin}`);
                    const buy = await placeOrder("buy", coin, tradeAmt);
                    if (buy) {
                        activeTrades.push({ symbol: coin, market: buy.market, entry: buy.price, qty: buy.qty });
                        fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(activeTrades, null, 2));
                    }
                }
            }
        }
    } catch (e) {
        log(`❌ SCANNER ERROR: ${e.message}`);
    } finally {
        isRunning = false;
    }
}

// --- 5. RENDER BOOT ---
app.get('/', (_, res) => res.send({ status: "Live", version: "18.1-Stable", bal: lastKnownBal }));

app.listen(PORT, '0.0.0.0', () => {
    log(`🚀 APEX v18.1 LIVE ON PORT ${PORT}`);
    runScanner(); 
    cron.schedule('*/1 * * * *', runScanner); 
});
