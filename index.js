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

// Loading State safely
if (fs.existsSync(STATE_FILE)) {
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { activeTrades = []; }
}

const botLog = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const signDCX = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(JSON.stringify(body)).digest('hex');

// ================= THE "NO-FAIL" ENGINE =================
async function executeOrder(side, binanceSymbol, amount, exactQty = null) {
    try {
        const coin = binanceSymbol.replace("USDT", "");
        
        // 1. DYNAMIC MARKET CHECK (Kills "not_found" error)
        const mDetails = await axios.get('https://api.coindcx.com/exchange/v1/markets_details', { timeout: 15000 });
        const mInfo = mDetails.data.find(m => m.symbol.includes(coin) && m.symbol.includes("USDT"));
        
        if (!mInfo) {
            botLog(`❌ Market ${coin} not found.`);
            return null;
        }

        const market = mInfo.symbol; 
        const precision = mInfo.target_currency_precision || 5;

        // 2. TICKER FETCH WITH HARD TIMEOUT (Kills "timeout" & "undefined" errors)
        const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker`, { timeout: 15000 });
        const data = tickerRes.data.find(m => m.market === market || m.pair === market);
        const price = data ? parseFloat(data.last_price) : 0;

        if (!price || price <= 0) {
            botLog("❌ Price fetch failed. Skipping.");
            return null;
        }

        const qty = exactQty ? Number(exactQty.toFixed(precision)) : Number((amount / price).toFixed(precision));

        // 3. EXECUTION
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
            timeout: 20000 // Extreme timeout for slow API
        });

        if (!res.data || res.data.status === "error" || res.data.code) {
            botLog(`❌ REJECTED: ${res.data.message || "Unknown Error"}`);
            return null;
        }

        botLog(`✅ ${side.toUpperCase()} SUCCESS: ${market}`);
        return { price, qty, market };

    } catch (e) {
        botLog(`❌ ENGINE ERROR: ${e.message}`);
        return null;
    }
}

// ================= SCANNER =================
const runScanner = async () => {
    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) },
            timeout: 10000
        });
        const usdt = (bRes.data || []).find(b => b.currency === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) : 0;
    } catch (e) { return botLog("⚠️ Balance Sync Fail"); }

    botLog(`🔍 SCAN | Bal: $${lastKnownBal.toFixed(2)}`);

    // Basic Strategy Logic
    for (const coin of WATCHLIST) {
        if (activeTrades.find(t => t.symbol === coin)) continue;

        // Simple check to see if we have enough balance to trade ($5 minimum)
        if (lastKnownBal > 5.0) {
            const tradeAmt = Math.min(lastKnownBal * 0.25, 20); // Trade 25% or max $20
            const bought = await executeOrder("buy", coin, tradeAmt);
            if (bought) {
                activeTrades.push({ symbol: coin, market: bought.market, entry: bought.price, qty: bought.qty });
                fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
            }
        }
    }
};

app.get('/status', (req, res) => res.json({ balance: lastKnownBal, activeTrades }));

app.listen(PORT, () => {
    botLog(`✅ APEX PRO v15.1 EMERGENCY FIX LIVE`);
    runScanner();
    cron.schedule('*/1 * * * *', runScanner); // Scans every 1 minute to avoid API spam
});
