const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
// RENDER FIX: Use process.env.PORT or default to 10000
const PORT = process.env.PORT || 10000;

const STATE_FILE = './state.json';
const WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'MATICUSDT'];
const ALLOCATION_PCT = 0.70; 
const STOP_LOSS_PCT = 1.5;   
const TAKE_PROFIT_PCT = 2.0; 

let activeTrades = [];
let lastKnownBal = 0;

if (fs.existsSync(STATE_FILE)) {
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { activeTrades = []; }
}

const botLog = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const signDCX = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(JSON.stringify(body)).digest('hex');

// ================= FIXED API ENGINE =================
async function executeOrder(side, binanceSymbol, amount, exactQty = null) {
    try {
        const coin = binanceSymbol.replace("USDT", "");
        
        // FIX: Using the correct public market details endpoint to avoid 404
        const mDetails = await axios.get('https://public.coindcx.com/exchange/ticker', { timeout: 30000 });
        const marketData = mDetails.data.find(m => m.market.includes(coin) && m.market.includes("USDT"));
        
        if (!marketData) {
            botLog(`❌ Market ${coin} not found.`);
            return null;
        }

        const market = marketData.market;
        const price = parseFloat(marketData.last_price);
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

        if (res.data && res.data.status !== "error") {
            botLog(`✅ ${side.toUpperCase()} SUCCESS: ${market}`);
            return { price, qty, market };
        }
        return null;
    } catch (e) {
        botLog(`❌ ORDER ERROR: ${e.message}`);
        return null;
    }
}

// ================= SCANNER & RISK MGMT =================
const runScanner = async () => {
    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) },
            timeout: 20000
        });
        const usdt = (bRes.data || []).find(b => b.currency === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) : 0;
    } catch (e) { return botLog("⚠️ Balance Sync Fail"); }

    botLog(`🔍 SCAN | Balance: $${lastKnownBal.toFixed(2)} | Active: ${activeTrades.length}`);

    // EXIT SYSTEM
    for (let i = activeTrades.length - 1; i >= 0; i--) {
        const t = activeTrades[i];
        const mDetails = await axios.get('https://public.coindcx.com/exchange/ticker').catch(()=>null);
        if (!mDetails) continue;
        
        const ticker = mDetails.data.find(m => m.market === t.market);
        if (!ticker) continue;

        const currentPrice = parseFloat(ticker.last_price);
        const pnl = ((currentPrice - t.entry) / t.entry) * 100;

        if (pnl <= -STOP_LOSS_PCT || pnl >= TAKE_PROFIT_PCT) {
            botLog(`🚨 EXIT: ${t.symbol} at ${pnl.toFixed(2)}%`);
            const sold = await executeOrder("sell", t.symbol, 0, t.qty);
            if (sold) {
                activeTrades.splice(i, 1);
                fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
            }
        }
    }

    // ENTRY SYSTEM
    for (const coin of WATCHLIST) {
        if (activeTrades.find(t => t.symbol === coin)) continue;

        const candles = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}&interval=1m&limit=30`).catch(()=>null);
        if (!candles || candles.data.length < 25) continue;

        const closes = candles.data.map(c => parseFloat(c[4]));
        const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();

        if (rsi < 65 && ema9 > ema21) {
            const tradeAmt = lastKnownBal * ALLOCATION_PCT;
            if (tradeAmt < 1) continue;

            const bought = await executeOrder("buy", coin, tradeAmt);
            if (bought) {
                activeTrades.push({ symbol: coin, market: bought.market, entry: bought.price, qty: bought.qty });
                fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
            }
        }
    }
};

// RENDER PORT BINDING FIX
app.get('/', (req, res) => res.send('Bot is Running'));

app.listen(PORT, '0.0.0.0', () => {
    botLog(`🚀 v15.8 DEPLOYED ON PORT ${PORT}`);
    runScanner();
    cron.schedule('*/1 * * * *', runScanner); 
});
