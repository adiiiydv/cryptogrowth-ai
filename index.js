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

if (fs.existsSync(STATE_FILE)) {
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch { activeTrades = []; }
}

const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
const sign = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(JSON.stringify(body)).digest('hex');

async function safeGet(url, timeout = 25000) {
    try {
        const res = await axios.get(url, { timeout });
        return res?.data || null;
    } catch { return null; }
}

// ================= ORDER ENGINE =================
async function placeOrder(side, symbol, amount, qtyOverride = null) {
    try {
        const coin = symbol.replace("USDT", "");
        const tickerData = await safeGet('https://public.coindcx.com/exchange/ticker');
        const market = tickerData?.find(m => m.market.includes(coin) && m.market.includes("USDT"));
        
        if (!market) return null;
        const price = parseFloat(market.last_price);
        const qty = qtyOverride ? Number(qtyOverride.toFixed(5)) : Number((amount / price).toFixed(5));

        const body = {
            side,
            order_type: "market_order",
            market: market.market,
            total_quantity: qty,
            timestamp: Date.now()
        };

        const res = await axios.post("https://api.coindcx.com/exchange/v1/orders/create", body, {
            headers: { "X-AUTH-APIKEY": process.env.COINDCX_API_KEY, "X-AUTH-SIGNATURE": sign(body), "Content-Type": "application/json" },
            timeout: 30000
        });

        if (res.data?.status !== "error") {
            log(`✅ ${side.toUpperCase()} SUCCESS: ${market.market}`);
            return { price, qty, market: market.market };
        }
        return null;
    } catch (e) { log(`❌ ORDER ERROR: ${e.message}`); return null; }
}

// ================= SCANNER WITH ANALYTICS =================
async function runScanner() {
    if (isRunning) return;
    isRunning = true;

    try {
        // 1. Refresh Balance
        const bBody = { timestamp: Date.now() };
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', bBody, {
            headers: { "X-AUTH-APIKEY": process.env.COINDCX_API_KEY, "X-AUTH-SIGNATURE": sign(bBody) },
            timeout: 15000
        }).catch(() => null);
        
        const usdt = bRes?.data?.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) : 0;

        log(`--- MARKET SCAN (Bal: $${lastKnownBal.toFixed(2)}) ---`);

        const tickerData = await safeGet('https://public.coindcx.com/exchange/ticker');

        // 2. Monitoring Active Trades (Exit Logic)
        for (let i = activeTrades.length - 1; i >= 0; i--) {
            const t = activeTrades[i];
            const m = tickerData?.find(x => x.market === t.market);
            if (!m) continue;

            const price = parseFloat(m.last_price);
            const pnl = ((price - t.entry) / t.entry) * 100;
            
            log(`📈 ACTIVE: ${t.symbol} | PNL: ${pnl.toFixed(2)}% | Price: ${price}`);

            if (pnl <= -STOP_LOSS_PCT || pnl >= TAKE_PROFIT_PCT) {
                const sold = await placeOrder("sell", t.symbol, 0, t.qty);
                if (sold) { activeTrades.splice(i, 1); fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades)); }
            }
        }

        // 3. Signal Detection (Entry Logic)
        for (const coin of WATCHLIST) {
            if (activeTrades.find(t => t.symbol === coin)) continue;

            const candles = await safeGet(`https://api.binance.com/api/v3/klines?symbol=${coin}&interval=1m&limit=40`);
            if (!candles || candles.length < 30) continue;

            const closes = candles.map(c => parseFloat(c[4]));
            const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
            const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();

            // VISIBILITY: This prints the RSI/EMA for every coin to your terminal
            log(`📊 ${coin.padEnd(8)} | RSI: ${rsi.toFixed(2)} | EMA9: ${ema9.toFixed(2)} | EMA21: ${ema21.toFixed(2)}`);

            if (rsi < 60 && ema9 > ema21) {
                log(`🎯 SIGNAL FOUND: Buying ${coin}...`);
                const tradeAmt = lastKnownBal * ALLOCATION_PCT;
                if (tradeAmt > 5) {
                    const buy = await placeOrder("buy", coin, tradeAmt);
                    if (buy) {
                        activeTrades.push({ symbol: coin, market: buy.market, entry: buy.price, qty: buy.qty });
                        fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
                    }
                }
            }
        }
    } catch (e) { log(`❌ SCAN ERROR: ${e.message}`); }
    finally { isRunning = false; }
}

app.get('/', (_, res) => res.send("ANALYTICS BOT ACTIVE"));
app.listen(PORT, '0.0.0.0', () => {
    log(`🚀 v16.2 LIVE | LOGGING RSI/EMA DATA`);
    runScanner();
    cron.schedule('*/1 * * * *', runScanner);
});
