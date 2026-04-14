const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
// FIX: Render requires binding to 0.0.0.0 and process.env.PORT
const PORT = process.env.PORT || 10000;

const STATE_FILE = './state.json';
const WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'MATICUSDT'];
const ALLOCATION_PCT = 0.75; 
const STOP_LOSS_PCT = 1.5;   // 1.5% Loss Exit
const TAKE_PROFIT_PCT = 2.5; // 2.5% Profit Exit

let activeTrades = [];
let lastKnownBal = 0;

if (fs.existsSync(STATE_FILE)) {
    try { activeTrades = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { activeTrades = []; }
}

const botLog = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const signDCX = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(JSON.stringify(body)).digest('hex');

// ================= FIXED ENGINE: 404 & TIMEOUT PROTECTION =================
async function executeOrder(side, binanceSymbol, amount, exactQty = null) {
    try {
        const coin = binanceSymbol.replace("USDT", "");
        
        // STABLE TICKER FETCH: Prevents the 404 errors from missing market info
        const mRes = await axios.get('https://public.coindcx.com/exchange/ticker', { timeout: 30000 });
        const mInfo = mRes.data.find(m => m.market.includes(coin) && m.market.includes("USDT"));
        
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

        if (res.data && res.data.status !== "error") {
            botLog(`✅ ${side.toUpperCase()} OK: ${market} @ ${price}`);
            return { price, qty, market };
        }
        return null;
    } catch (e) {
        botLog(`❌ EXECUTION FAIL: ${e.message}`);
        return null;
    }
}

// ================= RISK MANAGEMENT & SCANNER =================
const runScanner = async () => {
    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) },
            timeout: 20000
        });
        const usdt = (bRes.data || []).find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) : 0;
    } catch (e) { return botLog("⚠️ Balance Sync Latency"); }

    botLog(`🔍 SCAN | USDT: $${lastKnownBal.toFixed(2)} | Active: ${activeTrades.length}`);

    // EXIT LOGIC (Stop Loss / Take Profit)
    const tickerRes = await axios.get('https://public.coindcx.com/exchange/ticker').catch(()=>null);
    if (tickerRes && activeTrades.length > 0) {
        for (let i = activeTrades.length - 1; i >= 0; i--) {
            const t = activeTrades[i];
            const current = tickerRes.data.find(m => m.market === t.market);
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
    }

    // ENTRY LOGIC
    for (const coin of WATCHLIST) {
        if (activeTrades.find(t => t.symbol === coin)) continue;

        const candles = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}&interval=1m&limit=30`).catch(()=>null);
        if (!candles || candles.data.length < 25) continue;

        const closes = candles.data.map(c => parseFloat(c[4]));
        const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();

        if (rsi < 60 && ema9 > ema21) {
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

// ================= RENDER DEPLOYMENT FIX =================
app.get('/', (req, res) => res.send('Bot Active'));

app.listen(PORT, '0.0.0.0', () => {
    botLog(`🚀 v15.9 LIVE ON PORT ${PORT}`);
    runScanner();
    cron.schedule('*/1 * * * *', runScanner); 
});
