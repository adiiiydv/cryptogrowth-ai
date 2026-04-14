const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ================= CONFIG & RISK MGMT =================
const WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'MATICUSDT'];
const STATE_FILE = './state.json';
const ALLOCATION_PCT = 0.70; // Uses 70% of balance per trade
const STOP_LOSS_PCT = 1.5;   // Protection: Sell if price drops 1.5%
const TAKE_PROFIT_PCT = 2.0; // Profit: Sell if price gains 2.0%

let activeTrades = [];
let lastKnownBal = 0;

// Ensure state is loaded from file
if (fs.existsSync(STATE_FILE)) {
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { activeTrades = []; }
}

const botLog = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const signDCX = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(JSON.stringify(body)).digest('hex');

// ================= PRODUCTION STABLE ENGINE =================
async function executeOrder(side, binanceSymbol, amount, exactQty = null) {
    try {
        const coin = binanceSymbol.replace("USDT", "");
        
        // 1. Resolve exact market name (Fixes 404 & not_found)
        const mDetails = await axios.get('https://api.coindcx.com/exchange/v1/markets_details', { timeout: 25000 });
        const mInfo = mDetails.data.find(m => m.symbol.includes(coin) && m.symbol.includes("USDT"));
        
        if (!mInfo) {
            botLog(`❌ Market for ${coin} not found.`);
            return null;
        }

        const market = mInfo.symbol; 
        const precision = mInfo.target_currency_precision || 5;

        // 2. Get current price with heavy timeout
        const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker`, { timeout: 25000 });
        const data = tickerRes.data.find(m => m.market === market);
        const price = data ? parseFloat(data.last_price) : 0;

        if (!price || price <= 0) throw new Error("Price data unavailable");

        const qty = exactQty ? Number(exactQty.toFixed(precision)) : Number((amount / price).toFixed(precision));

        // 3. SECURE ORDER EXECUTION
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
            timeout: 30000 // 30-second production safety window
        });

        if (res.data && res.data.status !== "error") {
            botLog(`✅ ${side.toUpperCase()} SUCCESS: ${market} | Qty: ${qty}`);
            return { price, qty, market };
        } else {
            botLog(`❌ REJECTED: ${res.data.message || "Unknown Exchange Error"}`);
            return null;
        }
    } catch (e) {
        botLog(`❌ ENGINE ERROR: ${e.message}`);
        return null;
    }
}

// ================= SYSTEM SCANNER + RISK MGMT =================
const runScanner = async () => {
    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) },
            timeout: 15000
        });
        const usdt = (bRes.data || []).find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) : 0;
    } catch (e) { return botLog("⚠️ Balance Sync Fail (API Latency)"); }

    botLog(`🔍 SCAN | Balance: $${lastKnownBal.toFixed(2)} | Portfolio: ${activeTrades.length}`);

    // --- 1. EXIT SYSTEM (RISK MANAGEMENT) ---
    const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker`, { timeout: 15000 }).catch(() => null);
    if (tickerRes && activeTrades.length > 0) {
        for (let i = activeTrades.length - 1; i >= 0; i--) {
            const trade = activeTrades[i];
            const ticker = tickerRes.data.find(m => m.market === trade.market);
            if (!ticker) continue;

            const currentPrice = parseFloat(ticker.last_price);
            const pnl = ((currentPrice - trade.entry) / trade.entry) * 100;

            if (pnl <= -STOP_LOSS_PCT || pnl >= TAKE_PROFIT_PCT) {
                botLog(`🚨 EXIT SIGNAL: ${trade.symbol} | PNL: ${pnl.toFixed(2)}%`);
                const sold = await executeOrder("sell", trade.symbol, 0, trade.qty);
                if (sold) {
                    activeTrades.splice(i, 1);
                    fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
                }
            }
        }
    }

    // --- 2. ENTRY SYSTEM ---
    for (const coin of WATCHLIST) {
        if (activeTrades.find(t => t.symbol === coin)) continue;

        const candles = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}&interval=1m&limit=30`).catch(() => null);
        if (!candles || candles.data.length < 25) continue;

        const closes = candles.data.map(c => parseFloat(c[4]));
        const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();

        if (rsi < 65 && ema9 > ema21) {
            const tradeAmt = lastKnownBal * ALLOCATION_PCT;
            if (tradeAmt < 1) continue; // Ensure there's money to trade

            const bought = await executeOrder("buy", coin, tradeAmt);
            if (bought) {
                activeTrades.push({ symbol: coin, market: bought.market, entry: bought.price, qty: bought.qty });
                fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
            }
        }
    }
};

// ================= SERVER BOOT =================
app.listen(PORT, () => {
    botLog(`🚀 v15.7 STABILIZER ONLINE | EXIT SYSTEM ACTIVE`);
    runScanner();
    cron.schedule('*/1 * * * *', runScanner); // Clean 1-minute scan cycles
});
