const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA, ATR } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ================= CONFIG & STATE =================
const WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'MATICUSDT', 'ADAUSDT', 'XRPUSDT'];
const STATE_FILE = './bot_state.json';
const STATS_FILE = './bot_stats.json';
const FEES = 0.25; 
const TARGET_TRADES_PER_HOUR = 4;

let tradesThisHour = 0;
let lastHour = new Date().getHours();
let activeTrades = [];
let lastTradePerCoin = {}; 
let lastKnownBal = 0;
let lossStreak = 0;

// 📊 REAL-TIME STATS ENGINE
let stats = { totalTrades: 0, wins: 0, losses: 0, totalProfit: 0 };

// ================= PERSISTENCE =================
const loadData = () => {
    if (fs.existsSync(STATE_FILE)) activeTrades = JSON.parse(fs.readFileSync(STATE_FILE));
    if (fs.existsSync(STATS_FILE)) stats = JSON.parse(fs.readFileSync(STATS_FILE));
};
const saveData = () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
};
loadData();

const botLog = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

// ================= UTILS & SECURITY =================
const signDCX = (body) => crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY)
    .update(Buffer.from(JSON.stringify(body)).toString()).digest('hex');

const getCandles = async (symbol) => {
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=50`;
        const res = await axios.get(url, { timeout: 5000 });
        return res.data.map(d => ({ close: parseFloat(d[4]), high: parseFloat(d[2]), low: parseFloat(d[3]) }));
    } catch (e) { return []; }
};

// ================= SMART ORDER ENGINE =================
async function executeOrder(side, binanceSymbol, amount, exactQty = null, retry = 2) {
    try {
        // 1. Resolve Market ID & Precision
        const mDetails = await axios.get('https://api.coindcx.com/exchange/v1/markets_details', { timeout: 5000 });
        const coin = binanceSymbol.replace('USDT', '');
        const possibleIds = [binanceSymbol, `B-${coin}_USDT`, `${coin}_USDT` ];
        
        const mInfo = mDetails.data.find(m => possibleIds.includes(m.symbol) || possibleIds.includes(m.coindcx_name));
        if (!mInfo) throw new Error(`Market not found for ${binanceSymbol}`);

        const marketId = mInfo.symbol;
        const precision = mInfo.target_currency_precision || 5;

        // 2. Fetch Price with Slippage Buffer
        const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker`, { timeout: 5000 });
        const ticker = tickerRes.data.find(t => t.market === marketId);
        const price = parseFloat(ticker.last_price);
        const safePrice = side === "buy" ? price * 1.001 : price * 0.999;

        // 3. Precision-Correct Quantity
        const qty = exactQty ? Number(exactQty.toFixed(precision)) : Number((amount / safePrice).toFixed(precision));
        if (qty <= 0) return null;

        const body = { 
            side, 
            order_type: "market_order", 
            market: marketId, 
            total_quantity: qty, 
            timestamp: Date.now() 
        };

        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 
                'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 
                'X-AUTH-SIGNATURE': signDCX(body),
                'Content-Type': 'application/json'
            },
            timeout: 5000
        });

        return { price, qty, marketId };
    } catch (e) {
        if (retry > 0) return executeOrder(side, binanceSymbol, amount, exactQty, retry - 1);
        botLog(`❌ ${side.toUpperCase()} FAIL | ${binanceSymbol}: ${e.message}`);
        return null;
    }
}

// ================= RISK & SCANNER =================
const runScanner = async () => {
    if (new Date().getHours() !== lastHour) { tradesThisHour = 0; lastHour = new Date().getHours(); }
    if (lossStreak >= 5) return botLog("🛑 HALTED: Max Loss Streak.");

    // Sync Balance
    try {
        const body = { timestamp: Date.now() }; 
        const bRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdt = (bRes.data || []).find(b => b.currency === 'USDT' || b.asset === 'USDT');
        lastKnownBal = usdt ? parseFloat(usdt.balance) - parseFloat(usdt.locked_balance || 0) : 0;
    } catch (e) { return botLog("⚠️ Bal Err"); }

    const tickerRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker`);
    const allTickers = tickerRes.data || [];

    botLog(`🔍 SCAN | Bal: $${lastKnownBal.toFixed(2)} | Tr: ${tradesThisHour}/4 | Loss: ${lossStreak}`);

    // Check Exits
    for (let i = activeTrades.length - 1; i >= 0; i--) {
        const t = activeTrades[i];
        const ticker = allTickers.find(m => m.market === t.marketId);
        if (!ticker) continue;

        const p = parseFloat(ticker.last_price);
        if (p > t.highest) t.highest = p;

        const gain = ((p - t.entry) / t.entry) * 100;
        const drop = ((t.highest - p) / t.highest) * 100;
        const stopPct = (t.stop / t.entry) * 100;

        if ((gain > (1.2 + FEES) && drop > 0.3) || gain < -stopPct) {
            const sold = await executeOrder("sell", t.symbol, 0, t.qty);
            if (sold) {
                stats.totalTrades++;
                stats.totalProfit += gain;
                if (gain > 0) { stats.wins++; lossStreak = 0; }
                else { stats.losses++; lossStreak++; }

                activeTrades.splice(i, 1);
                saveData();
                botLog(`💰 EXIT ${t.symbol} | PnL: ${gain.toFixed(2)}% | Strk: ${lossStreak}`);
            }
        }
    }

    // Entries
    for (const coin of WATCHLIST) {
        if (activeTrades.find(t => t.symbol === coin)) continue;
        if (Date.now() - (lastTradePerCoin[coin] || 0) < 60000) continue;

        const candles = await getCandles(coin);
        if (candles.length < 30) continue;

        const closes = candles.map(c => c.close);
        const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();
        const atr = ATR.calculate({ high: candles.map(c=>c.high), low: candles.map(c=>c.low), close: closes, period: 14 }).pop();

        const score = (rsi < 60 ? 1 : 0) + (ema9 > ema21 ? 1 : 0) + (closes.at(-1) > closes.at(-2) ? 1 : 0);
        
        if (score === 3 && tradesThisHour < TARGET_TRADES_PER_HOUR && lastKnownBal > 5.0) {
            const bought = await executeOrder("buy", coin, lastKnownBal * 0.40);
            if (bought) {
                activeTrades.push({ 
                    symbol: coin, 
                    marketId: bought.marketId,
                    entry: bought.price, 
                    qty: bought.qty, 
                    highest: bought.price, 
                    stop: atr ? atr * 1.5 : bought.price * 0.015 
                });
                lastTradePerCoin[coin] = Date.now();
                tradesThisHour++;
                saveData();
                botLog(`🚀 ENTRY: ${coin} @ ${bought.price}`);
            }
        }
    }
};

// ================= SERVER =================
app.get('/status', (req, res) => {
    res.json({
        balance: lastKnownBal,
        activeTrades,
        lossStreak,
        stats: { ...stats, winRate: stats.totalTrades ? ((stats.wins / stats.totalTrades) * 100).toFixed(2) : 0 }
    });
});

app.listen(PORT, '0.0.0.0', () => {
    botLog(`✅ APEX PRO v13.0 DEPLOYED | PORT ${PORT}`);
    runScanner();
    cron.schedule('*/30 * * * * *', runScanner);
});
