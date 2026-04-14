const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ================= CONFIG & STATE =================
const WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'MATICUSDT', 'ADAUSDT', 'XRPUSDT'];
const STATE_FILE = './state.json';
let activeTrades = [];
let lastKnownBal = 0;

if (fs.existsSync(STATE_FILE)) {
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { activeTrades = []; }
}

const botLog = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const signDCX = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(JSON.stringify(body)).digest('hex');

// ================= THE "MAX-FORCE" ENGINE =================
async function executeOrder(side, binanceSymbol, amount, exactQty = null) {
    try {
        const coin = binanceSymbol.replace("USDT", "");
        
        // 1. Resolve exact market name (Increased timeout to fix "not_found")
        const mDetails = await axios.get('https://api.coindcx.com/exchange/v1/markets_details', { timeout: 20000 });
        const mInfo = mDetails.data.find(m => m.symbol.includes(coin) && m.symbol.includes("USDT"));
        
        if (!mInfo) {
            botLog(`❌ Market ${coin} not found.`);
            return null;
        }

        const market = mInfo.symbol; 
        const precision = mInfo.target_currency_precision || 5;

        // 2. Ticker fetch (Extended timeout to fix "undefined")
        const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker`, { timeout: 20000 });
        const data = tickerRes.data.find(m => m.market === market || m.pair === market);
        const price = data ? parseFloat(data.last_price) : 0;

        if (!price || price <= 0) {
            botLog("❌ Price fetch failed.");
            return null;
        }

        const qty = exactQty ? Number(exactQty.toFixed(precision)) : Number((amount / price).toFixed(precision));

        // 3. Force Order Execution
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
            timeout: 30000 // Heavy 30s timeout for slow API responses
        });

        if (!res.data || res.data.status === "error" || res.data.code) {
            botLog(`❌ REJECTED: ${res.data.message || "Check Exchange Limits"}`);
            return null;
        }

        botLog(`✅ ${side.toUpperCase()} SUCCESS: ${market} | Qty: ${qty}`);
        return { price, qty, market };

    } catch (e) {
        botLog(`❌ ENGINE ERROR: ${e.message}`);
        return null;
    }
}

// ================= SCANNER =================
async function getCandles(symbol) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=50`, { timeout: 10000 });
        return res.data.map(c => ({ close: parseFloat(c[4]) }));
    } catch { return []; }
}

const runScanner = async () => {
    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) },
            timeout: 15000
        });
        const usdt = (bRes.data || []).find(b => b.currency === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) : 0;
    } catch (e) { return botLog("⚠️ Balance Sync Fail"); }

    botLog(`🔍 SCAN | Bal: $${lastKnownBal.toFixed(2)} | Alloc: 50-75%`);

    for (const coin of WATCHLIST) {
        if (activeTrades.find(t => t.symbol === coin)) continue;

        const candles = await getCandles(coin);
        if (candles.length < 30) continue;

        const closes = candles.map(c => c.close);
        const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();

        // High-Intensity Entry Signal
        if (rsi < 70 && ema9 > ema21) {
            // Updated to 50% - 75% Allocation
            const allocation = 0.65; // Aims for 65% average
            const tradeAmt = lastKnownBal * allocation; 
            
            if (tradeAmt > 0) {
                const bought = await executeOrder("buy", coin, tradeAmt);
                if (bought) {
                    activeTrades.push({ symbol: coin, market: bought.market, entry: bought.price, qty: bought.qty });
                    fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
                }
            }
        }
    }
};

app.listen(PORT, () => {
    botLog(`🚀 APEX PRO v15.3 | 75% ALLOCATION LIVE`);
    runScanner();
    cron.schedule('*/30 * * * * *', runScanner); 
});
