const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// ================= CONFIG & RISK MGMT =================
const STATE_FILE = './state.json';
const WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'MATICUSDT'];
const ALLOCATION_PCT = 0.70; 
const STOP_LOSS_PCT = 1.5;   
const TAKE_PROFIT_PCT = 2.5; 

let activeTrades = [];
let lastKnownBal = 0;
let isRunning = false;

// ================= LOAD STATE =================
if (fs.existsSync(STATE_FILE)) {
    try { 
        activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); 
    } catch (e) { 
        activeTrades = []; 
    }
}

const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
const sign = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(JSON.stringify(body)).digest('hex');

// ================= UTILITIES =================
async function safeGet(url, timeout = 25000) {
    try {
        const res = await axios.get(url, { timeout });
        return res?.data || null;
    } catch (e) { 
        return null; 
    }
}

// ================= UNIFIED ORDER ENGINE =================
async function placeOrder(side, symbol, amount, qtyOverride = null) {
    try {
        const coin = symbol.replace("USDT", "");
        
        // 1. Fetch Market Ticker
        const tickerData = await safeGet('https://public.coindcx.com/exchange/ticker');
        if (!Array.isArray(tickerData)) return null;

        // 2. Smart Market Mapping (Handles standard and B- prefixes)
        const market = tickerData.find(m => 
            m.market === `${coin}USDT` || 
            m.market === `B-${coin}_USDT` ||
            (m.market.includes(coin) && m.market.includes("USDT"))
        );
        
        if (!market || !market.last_price) {
            log(`❌ Market Not Found: ${coin}`);
            return null;
        }

        const price = Number(market.last_price);
        const qty = qtyOverride ? Number(qtyOverride.toFixed(5)) : Number((amount / price).toFixed(5));

        const body = {
            side,
            order_type: "market_order",
            market: market.market,
            total_quantity: qty,
            timestamp: Date.now()
        };

        // 3. API Execution
        const res = await axios.post("https://api.coindcx.com/exchange/v1/orders/create", body, {
            headers: { 
                "X-AUTH-APIKEY": process.env.COINDCX_API_KEY, 
                "X-AUTH-SIGNATURE": sign(body), 
                "Content-Type": "application/json" 
            },
            timeout: 30000
        });

        if (res.data && res.data.status !== "error" && res.data.order_id) {
            log(`✅ ${side.toUpperCase()} SUCCESS: ${market.market} @ ${price}`);
            return { price, qty, market: market.market };
        } else {
            log(`❌ EXCH REJECT: ${res.data?.message || "Check Balance/Min Order"}`);
            return null;
        }
    } catch (e) { 
        log(`❌ ORDER ENGINE CRITICAL ERROR: ${e.message}`); 
        return null; 
    }
}

// ================= ANALYTIC SCANNER =================
async function runScanner() {
    if (isRunning) return;
    isRunning = true;

    try {
        // 1. Refresh Balance
        const bBody = { timestamp: Date.now() };
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', bBody, {
            headers: { 
                "X-AUTH-APIKEY": process.env.COINDCX_API_KEY, 
                "X-AUTH-SIGNATURE": sign(bBody) 
            },
            timeout: 20000
        }).catch(() => null);
        
        const usdt = bRes?.data?.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = usdt ? Number(usdt.balance) : 0;

        log(`--- SCAN | BAL: $${lastKnownBal.toFixed(2)} | ACTIVE: ${activeTrades.length} ---`);

        const tickerData = await safeGet('https://public.coindcx.com/exchange/ticker');
        if (!Array.isArray(tickerData)) {
            isRunning = false;
            return;
        }

        // 2. Monitoring Active Trades (Exit System)
        for (let i = activeTrades.length - 1; i >= 0; i--) {
            const t = activeTrades[i];
            const m = tickerData.find(x => x.market === t.market);
            if (!m) continue;

            const price = Number(m.last_price);
            const pnl = ((price - t.entry) / t.entry) * 100;
            
            log(`📈 TRADE: ${t.symbol} | PNL: ${pnl.toFixed(2)}% | Price: ${price}`);

            if (pnl <= -STOP_LOSS_PCT || pnl >= TAKE_PROFIT_PCT) {
                const sold = await placeOrder("sell", t.symbol, 0, t.qty);
                if (sold) { 
                    activeTrades.splice(i, 1); 
                    fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades, null, 2)); 
                }
            }
        }

        // 3. Signal Detection (Entry System)
        for (const coin of WATCHLIST) {
            if (activeTrades.some(t => t.symbol === coin)) continue;

            const candles = await safeGet(`https://api.binance.com/api/v3/klines?symbol=${coin}&interval=1m&limit=40`);
            if (!Array.isArray(candles) || candles.length < 30) continue;

            const closes = candles.map(c => Number(c[4]));
            const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
            const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();

            if (!rsi || !ema9 || !ema21) continue;

            // Log indicators for visibility
            log(`📊 ${coin.padEnd(8)} | RSI: ${rsi.toFixed(2)} | EMA9: ${ema9.toFixed(2)} | EMA21: ${ema21.toFixed(2)}`);

            if (rsi < 60 && ema9 > ema21) {
                const tradeAmt = lastKnownBal * ALLOCATION_PCT;
                
                // Safety: Minimum trade amount to prevent micro-order errors
                if (tradeAmt > 1.5) {
                    log(`🎯 SIGNAL: Buying ${coin}...`);
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

// ================= SERVER BOOT =================
app.get('/', (_, res) => res.send("APEX UNIFIED BOT v16.5 ACTIVE"));

app.listen(PORT, '0.0.0.0', () => {
    log(`🚀 BOT DEPLOYED ON PORT ${PORT}`);
    runScanner(); // Run immediately on start
    cron.schedule('*/1 * * * *', runScanner); // Scan every minute
});
