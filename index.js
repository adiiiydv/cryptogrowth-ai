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
const ALLOCATION_PCT = 0.75; 
const STOP_LOSS_PCT = 1.5;   
const TAKE_PROFIT_PCT = 2.5; 
const MAX_PORTFOLIO_RISK = 0.5; // 50% cap

let activeTrades = [];
let lastKnownBal = 0;
let isRunning = false; // SNIPPET 2: Lock to prevent duplicate cron overlaps

if (fs.existsSync(STATE_FILE)) {
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { activeTrades = []; }
}

const botLog = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const signDCX = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(JSON.stringify(body)).digest('hex');

// ================= BOOT-LEVEL RETRY SYSTEM =================
const fetchWithRetry = async (url, options = {}, retries = 3) => {
    try {
        return await axios.get(url, options);
    } catch (err) {
        if (retries > 0) {
            await new Promise(r => setTimeout(r, 2000));
            return fetchWithRetry(url, options, retries - 1);
        }
        throw err;
    }
};

// ================= ENGINE: PROTECTION & CONFIRMATION =================
async function executeOrder(side, binanceSymbol, amount, exactQty = null) {
    try {
        const coin = binanceSymbol.replace("USDT", "");
        
        // SNIPPET 3: Optional Chaining & Default Empty Array for safety
        const mRes = await fetchWithRetry('https://public.coindcx.com/exchange/ticker', { timeout: 30000 });
        const tickerData = mRes?.data || []; 
        const mInfo = tickerData.find(m => m.market.includes(coin) && m.market.includes("USDT"));
        
        if (!mInfo) {
            botLog(`❌ Market ${coin} Not Found`);
            return null;
        }

        const market = mInfo.market;
        const price = parseFloat(mInfo.last_price);
        const qty = exactQty ? Number(exactQty.toFixed(5)) : Number((amount / price).toFixed(5));

        const body = {
            side,
            order_type: "market_order",
            market: market,
            total_quantity: qty,
            timestamp: Date.now()
        };

        const res = await axios.post("https://api.coindcx.com/exchange/v1/orders/create", body, {
            headers: {
                "X-AUTH-APIKEY": process.env.COINDCX_API_KEY,
                "X-AUTH-SIGNATURE": signDCX(body),
                "Content-Type": "application/json"
            },
            timeout: 30000 
        });

        // SNIPPET 5: Order Confirmation Tracking
        if (res.data && res.data.status !== "error") {
            botLog(`✅ ${side.toUpperCase()} EXECUTED: ${market} | Waiting for propagation...`);
            await new Promise(r => setTimeout(r, 1500)); // Cool-down to prevent spam
            return { price, qty, market };
        }
        return null;
    } catch (e) {
        botLog(`❌ EXECUTION FAIL: ${e.message}`);
        return null;
    }
}

// ================= SCANNER: LOCKS & RISK LOGIC =================
const runScanner = async () => {
    // SNIPPET 2: Process Lock (Prevents duplicate buy spam if API is slow)
    if (isRunning) return botLog("⏳ Previous scan still running. Skipping...");
    isRunning = true;

    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) },
            timeout: 20000
        });
        const usdt = (bRes?.data || []).find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) : 0;

        botLog(`🔍 SCAN | USDT: $${lastKnownBal.toFixed(2)} | Active: ${activeTrades.length}`);

        // EXIT SYSTEM: Snippet 1 style finding
        const tickerRes = await fetchWithRetry('https://public.coindcx.com/exchange/ticker').catch(()=>null);
        const tickerData = tickerRes?.data || [];

        for (let i = activeTrades.length - 1; i >= 0; i--) {
            const t = activeTrades[i];
            const current = tickerData.find(m => m.market === t.market); // SNIPPET 1
            if (!current) continue;

            const pnl = ((parseFloat(current.last_price) - t.entry) / t.entry) * 100;
            if (pnl <= -STOP_LOSS_PCT || pnl >= TAKE_PROFIT_PCT) {
                botLog(`🚨 EXIT ${t.symbol}: ${pnl.toFixed(2)}%`);
                const sold = await executeOrder("sell", t.symbol, 0, t.qty);
                if (sold) {
                    activeTrades.splice(i, 1);
                    fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
                }
            }
        }

        // ENTRY SYSTEM: Snippet 4 logic
        for (const coin of WATCHLIST) {
            if (activeTrades.find(t => t.symbol === coin)) continue;

            const candles = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}&interval=1m&limit=30`).catch(()=>null);
            if (!candles || !candles.data || candles.data.length < 25) continue;

            const closes = candles.data.map(c => parseFloat(c[4]));
            const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
            const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();

            if (rsi < 60 && ema9 > ema21) {
                // SNIPPET 4: Risk-Adjusted Trade Amount
                const tradeAmt = Math.min(
                    lastKnownBal * ALLOCATION_PCT,
                    (lastKnownBal * MAX_PORTFOLIO_RISK) / WATCHLIST.length
                );

                if (tradeAmt < 1) continue;
                
                const bought = await executeOrder("buy", coin, tradeAmt);
                if (bought) {
                    activeTrades.push({ symbol: coin, market: bought.market, entry: bought.price, qty: bought.qty });
                    fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
                }
            }
        }
    } catch (e) {
        botLog(`⚠️ Scanner Error: ${e.message}`);
    } finally {
        isRunning = false; // SNIPPET 2: Always unlock
    }
};

app.get('/', (req, res) => res.send('Bot Online - Industrial Build v16.0'));

app.listen(PORT, '0.0.0.0', () => {
    botLog(`🚀 DEPLOYED ON PORT ${PORT} | SAFETY LOCKS ACTIVE`);
    runScanner();
    cron.schedule('*/1 * * * *', runScanner); 
});
