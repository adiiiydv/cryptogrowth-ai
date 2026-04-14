const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// ================= CONFIG =================
const STATE_FILE = './state.json';
const WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'MATICUSDT'];
const ALLOCATION_PCT = 0.70;
const STOP_LOSS_PCT = 1.5;
const TAKE_PROFIT_PCT = 2.5;

let activeTrades = [];
let lastKnownBal = 0;
let isRunning = false;

// MARKET CACHE (Prevents 404s and API Rate Limiting)
let marketCache = null;
let marketCacheTime = 0;
const MARKET_CACHE_TTL = 60 * 1000; 

// ================= LOAD STATE =================
if (fs.existsSync(STATE_FILE)) {
    try {
        activeTrades = JSON.parse(fs.readFileSync(STATE_FILE));
    } catch {
        activeTrades = [];
    }
}

const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);

const sign = (body) =>
    crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY)
        .update(JSON.stringify(body))
        .digest('hex');

// ================= SAFE REQUESTS =================
async function safeGet(url, timeout = 25000, retries = 2) {
    try {
        const res = await axios.get(url, { timeout });
        return res?.data || null;
    } catch (e) {
        if (retries > 0) {
            await new Promise(r => setTimeout(r, 1500));
            return safeGet(url, timeout, retries - 1);
        }
        return null;
    }
}

async function getMarkets() {
    const now = Date.now();
    if (marketCache && (now - marketCacheTime < MARKET_CACHE_TTL)) {
        return marketCache;
    }
    const data = await safeGet('https://public.coindcx.com/exchange/ticker');
    if (Array.isArray(data)) {
        marketCache = data;
        marketCacheTime = now;
    }
    return marketCache || [];
}

// ================= UNIFIED ORDER ENGINE =================
async function placeOrder(side, symbol, amount, qtyOverride = null) {
    try {
        const coin = symbol.replace("USDT", "");
        const markets = await getMarkets();

        const market = markets.find(m =>
            m.market === `${coin}USDT` ||
            m.market === `B-${coin}_USDT` ||
            m.market.includes(coin)
        );

        if (!market?.last_price) {
            log(`❌ Market Mapping Failed: ${coin}`);
            return null;
        }

        const price = Number(market.last_price);
        const qty = qtyOverride 
            ? Number(qtyOverride.toFixed(5)) 
            : Number((amount / price).toFixed(5));

        const body = {
            side,
            order_type: "market_order",
            market: market.market,
            total_quantity: qty,
            timestamp: Date.now()
        };

        const res = await axios.post("https://api.coindcx.com/exchange/v1/orders/create", body, {
            headers: {
                "X-AUTH-APIKEY": process.env.COINDCX_API_KEY,
                "X-AUTH-SIGNATURE": sign(body),
                "Content-Type": "application/json"
            },
            timeout: 30000
        });

        if (res?.data && res.data.status !== "error" && res.data.order_id) {
            log(`✅ ${side.toUpperCase()} SUCCESS: ${market.market} @ ${price}`);
            return { price, qty, market: market.market };
        }

        log(`❌ ORDER REJECTED: ${res?.data?.message || "Unknown Error"}`);
        return null;

    } catch (e) {
        log(`❌ ORDER ENGINE CRITICAL ERROR: ${e.message}`);
        return null;
    }
}

// ================= ANALYTIC SCANNER =================
async function runScanner() {
    if (isRunning) {
        log("⏳ Scan locked (previous process active)");
        return;
    }
    isRunning = true;

    try {
        // 1. Refresh Balance
        const bBody = { timestamp: Date.now() };
        const balRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', bBody, {
            headers: {
                "X-AUTH-APIKEY": process.env.COINDCX_API_KEY,
                "X-AUTH-SIGNATURE": sign(bBody)
            },
            timeout: 20000
        }).catch(() => null);

        const usdt = balRes?.data?.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = Number(usdt?.balance || usdt?.available_balance || 0);

        log(`--- SCAN | BAL: $${lastKnownBal.toFixed(2)} | ACTIVE: ${activeTrades.length} ---`);

        const markets = await getMarkets();
        if (markets.length === 0) { isRunning = false; return; }

        // 2. Exit Logic (Monitoring)
        for (let i = activeTrades.length - 1; i >= 0; i--) {
            const t = activeTrades[i];
            const m = markets.find(x => x.market === t.market);
            if (!m) continue;

            const price = Number(m.last_price);
            const pnl = ((price - t.entry) / t.entry) * 100;

            log(`📈 ACTIVE: ${t.symbol.padEnd(8)} | PNL: ${pnl.toFixed(2)}%`);

            if (pnl <= -STOP_LOSS_PCT || pnl >= TAKE_PROFIT_PCT) {
                log(`🚨 EXIT SIGNAL: ${t.symbol}`);
                const sold = await placeOrder("sell", t.symbol, 0, t.qty);
                if (sold) {
                    activeTrades.splice(i, 1);
                    fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades, null, 2));
                }
            }
        }

        // 3. Entry Logic (Signal Detection)
        for (const coin of WATCHLIST) {
            if (activeTrades.some(t => t.symbol === coin)) continue;

            const candles = await safeGet(`https://api.binance.com/api/v3/klines?symbol=${coin}&interval=1m&limit=40`);
            if (!Array.isArray(candles) || candles.length < 30) continue;

            const closes = candles.map(c => Number(c[4]));
            const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
            const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();

            if (!rsi || !ema9 || !ema21) continue;

            log(`📊 ${coin.padEnd(8)} | RSI: ${rsi.toFixed(1)} | EMA9: ${ema9.toFixed(1)} | EMA21: ${ema21.toFixed(1)}`);

            if (rsi < 60 && ema9 > ema21) {
                const tradeAmt = lastKnownBal * ALLOCATION_PCT;

                if (tradeAmt > 2.0) {
                    log(`🎯 BUY SIGNAL: ${coin}`);
                    const buy = await placeOrder("buy", coin, tradeAmt);
                    if (buy) {
                        activeTrades.push({
                            symbol: coin,
                            market: buy.market,
                            entry: buy.price,
                            qty: buy.qty
                        });
                        fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades, null, 2));
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

// ================= SERVER =================
app.get('/', (_, res) => res.send("APEX HEDGE v17.3 ACTIVE"));

app.listen(PORT, '0.0.0.0', () => {
    log(`🚀 BOT DEPLOYED ON PORT ${PORT}`);
    runScanner(); 
    cron.schedule('*/1 * * * *', runScanner);
});
