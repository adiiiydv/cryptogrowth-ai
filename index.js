/**
 * APEX HEDGE v21.0 - STABLE PRODUCTION
 * Focus: High Visibility Logs & Improved Entry Logic
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
    ALLOCATION_PCT: 1.0, 
    TP: 2.0, 
    SL: 1.5,
    MIN_VAL: 5.0
};

let activeTrades = [];
if (fs.existsSync(STATE_FILE)) { 
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch(e) { activeTrades = []; }
}

const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
const sign = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(JSON.stringify(body)).digest('hex');

async function getMarket(symbol) {
    try {
        const coin = symbol.replace("USDT", "");
        const res = await axios.get('https://public.coindcx.com/exchange/ticker');
        const names = [`${coin}USDT`, `B-${coin}_USDT`, `${coin}_USDT` ];
        return res.data.find(m => names.includes(m.market)) || null;
    } catch (e) { return null; }
}

async function placeOrder(side, symbol, amount, qtyOverride = null) {
    try {
        const mData = await getMarket(symbol);
        if (!mData) return null;

        const price = Number(mData.last_price);
        const qty = qtyOverride ? Number(qtyOverride.toFixed(5)) : Number((amount / price).toFixed(5));

        const body = {
            side,
            order_type: "market_order",
            market: mData.market,
            total_quantity: qty,
            timestamp: Date.now()
        };

        const res = await axios.post("https://api.coindcx.com/exchange/v1/orders/create", body, {
            headers: { "X-AUTH-APIKEY": process.env.COINDCX_API_KEY, "X-AUTH-SIGNATURE": sign(body) }
        });

        if (res.data && res.data.status !== "error") {
            log(`✅ ${side.toUpperCase()} EXECUTED: ${mData.market} @ ${price}`);
            return { price, qty, market: mData.market };
        }
        log(`❌ EXCH REFUSED: ${res.data.message || "Unknown Error"}`);
        return null;
    } catch (e) { 
        log(`❌ ORDER FAILED: ${e.message}`);
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

        log(`--- HEARTBEAT | BAL: $${bal.toFixed(2)} | ACTIVE TRADES: ${activeTrades.length} ---`);

        if (bal < CONFIG.MIN_VAL && activeTrades.length === 0) {
            log(`⚠️ Waiting for balance to stay above $5.00`);
            return;
        }

        const ticker = await axios.get('https://public.coindcx.com/exchange/ticker');
        
        // EXIT CHECK
        for (let i = activeTrades.length - 1; i >= 0; i--) {
            const t = activeTrades[i];
            const m = ticker.data.find(x => x.market === t.market);
            if (!m) continue;
            const currentPrice = Number(m.last_price);
            const pnl = ((currentPrice - t.entry) / t.entry) * 100;
            log(`📊 POSITION: ${t.symbol} | PNL: ${pnl.toFixed(2)}% | Price: ${currentPrice}`);

            if (pnl >= CONFIG.TP || pnl <= -CONFIG.SL) {
                log(`🚨 EXIT SIGNAL for ${t.symbol}`);
                const sold = await placeOrder("sell", t.symbol, 0, t.qty);
                if (sold) { 
                    activeTrades.splice(i, 1); 
                    fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades)); 
                }
            }
        }

        // ENTRY SCAN
        for (const coin of CONFIG.WATCHLIST) {
            if (activeTrades.some(t => t.symbol === coin)) continue;
            
            const cndl = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}&interval=1m&limit=50`).catch(() => null);
            if (!cndl) continue;

            const cls = cndl.data.map(c => Number(c[4]));
            const rsi = RSI.calculate({ values: cls, period: 14 }).pop();
            const e9 = EMA.calculate({ values: cls, period: 9 }).pop();
            const e21 = EMA.calculate({ values: cls, period: 21 }).pop();

            // VISIBILITY: Log the indicators so you can see them moving
            log(`🔍 SCAN: ${coin.padEnd(8)} | RSI: ${rsi.toFixed(2)} | EMA9: ${e9.toFixed(2)} | EMA21: ${e21.toFixed(2)}`);

            // ENTRY LOGIC: Buy when RSI is oversold (< 45) OR EMA cross occurs
            if (rsi < 45 || e9 > e21) {
                log(`🎯 SIGNAL FOUND: Buying ${coin}`);
                const buy = await placeOrder("buy", coin, bal * CONFIG.ALLOCATION_PCT);
                if (buy) {
                    activeTrades.push({ symbol: coin, market: buy.market, entry: buy.price, qty: buy.qty });
                    fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
                    break; 
                }
            }
        }
    } catch (e) {
        log(`❌ SCANNER ERROR: ${e.message}`);
    }
}

app.get('/', (req, res) => res.send("APEX BOT ACTIVE"));
app.listen(PORT, '0.0.0.0', () => {
    log(`🚀 DEPLOYED ON PORT ${PORT}`);
    runScanner();
    cron.schedule('*/1 * * * *', runScanner);
});
