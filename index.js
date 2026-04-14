const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ================= CONFIG =================
const WATCHLIST = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT',
  'DOGEUSDT','MATICUSDT','ADAUSDT','XRPUSDT'
];

const STATE_FILE = './state.json';

const ALLOCATION_PCT = 0.70;
const STOP_LOSS_PCT = 1.5;
const TAKE_PROFIT_PCT = 2.0;

let activeTrades = [];
let lastKnownBal = 0;

// ================= LOAD STATE =================
if (fs.existsSync(STATE_FILE)) {
  try {
    activeTrades = JSON.parse(fs.readFileSync(STATE_FILE));
  } catch {
    activeTrades = [];
  }
}

const botLog = (msg) =>
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

const signDCX = (body) =>
  crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY)
    .update(JSON.stringify(body))
    .digest('hex');

// ================= MARKET RESOLVER =================
async function getMarket(coin) {
  const res = await axios.get(
    'https://api.coindcx.com/exchange/v1/markets_details',
    { timeout: 30000 }
  );

  const match = res.data.find(m =>
    m.symbol === `B-${coin}_USDT`
  );

  return match || null;
}

// ================= ORDER ENGINE =================
async function executeOrder(side, symbol, amount, exactQty = null) {
  try {
    const coin = symbol.replace("USDT", "");
    const mInfo = await getMarket(coin);

    if (!mInfo) {
      botLog(`❌ MARKET NOT FOUND: ${coin}`);
      return null;
    }

    const market = mInfo.symbol;
    const precision = mInfo.target_currency_precision || 5;

    const ticker = await axios.get(
      'https://api.coindcx.com/exchange/v1/markets/ticker',
      { timeout: 30000 }
    );

    const data = ticker.data.find(t =>
      t.market === market
    );

    const price = parseFloat(data?.last_price);

    if (!price || price <= 0) {
      botLog(`❌ INVALID PRICE: ${market}`);
      return null;
    }

    const qty = exactQty
      ? Number(exactQty.toFixed(precision))
      : Number((amount / price).toFixed(precision));

    const body = {
      side,
      order_type: "market_order",
      market,
      total_quantity: qty,
      timestamp: Date.now()
    };

    const res = await axios.post(
      'https://api.coindcx.com/exchange/v1/orders/create',
      body,
      {
        headers: {
          "X-AUTH-APIKEY": process.env.COINDCX_API_KEY,
          "X-AUTH-SIGNATURE": signDCX(body),
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    if (!res.data || res.data.status === "error") {
      botLog(`❌ ORDER REJECTED`);
      return null;
    }

    botLog(`✅ ${side.toUpperCase()} EXECUTED: ${market}`);
    return { price, qty, market };

  } catch (e) {
    botLog(`❌ ORDER ERROR: ${e.message}`);
    return null;
  }
}

// ================= CANDLE DATA =================
async function getCandles(symbol) {
  try {
    const res = await axios.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=50`,
      { timeout: 10000 }
    );

    return res.data.map(c => parseFloat(c[4]));
  } catch {
    return [];
  }
}

// ================= SCANNER =================
const runScanner = async () => {
  try {
    const bal = await axios.post(
      'https://api.coindcx.com/exchange/v1/users/balances',
      { timestamp: Date.now() },
      {
        headers: {
          "X-AUTH-APIKEY": process.env.COINDCX_API_KEY,
          "X-AUTH-SIGNATURE": signDCX({ timestamp: Date.now() })
        },
        timeout: 30000
      }
    );

    const usdt = bal.data.find(b => b.currency === "USDT");
    lastKnownBal = usdt ? parseFloat(usdt.balance) : 0;

  } catch {
    return botLog("⚠️ BALANCE ERROR");
  }

  botLog(`🔍 SCAN | BAL: $${lastKnownBal.toFixed(2)}`);

  // ================= EXIT LOGIC =================
  const tickerRes = await axios.get(
    'https://api.coindcx.com/exchange/v1/markets/ticker',
    { timeout: 30000 }
  );

  for (let i = activeTrades.length - 1; i >= 0; i--) {
    const t = activeTrades[i];

    const data = tickerRes.data.find(m => m.market === t.market);
    const price = parseFloat(data?.last_price);

    if (!price) continue;

    const pnl = ((price - t.entry) / t.entry) * 100;

    if (!t.high) t.high = price;
    if (price > t.high) t.high = price;

    const drop = ((t.high - price) / t.high) * 100;

    if (pnl >= TAKE_PROFIT_PCT || pnl <= -STOP_LOSS_PCT) {
      botLog(`🚨 EXIT ${t.market} | PNL: ${pnl.toFixed(2)}%`);

      await executeOrder("sell", t.symbol, 0, t.qty);
      activeTrades.splice(i, 1);

      fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
    }
  }

  // ================= ENTRY LOGIC =================
  for (const coin of WATCHLIST) {
    if (activeTrades.find(t => t.symbol === coin)) continue;

    const closes = await getCandles(coin);
    if (closes.length < 30) continue;

    const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
    const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
    const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();

    if (rsi < 65 && ema9 > ema21 && lastKnownBal > 5) {
      const tradeAmt = lastKnownBal * ALLOCATION_PCT;

      const bought = await executeOrder("buy", coin, tradeAmt);

      if (bought) {
        activeTrades.push({
          symbol: coin,
          market: bought.market,
          entry: bought.price,
          qty: bought.qty,
          high: bought.price
        });

        fs.writeFileSync(STATE_FILE, JSON.stringify(activeTrades));
      }
    }
  }
};

// ================= START =================
app.listen(PORT, () => {
  botLog(`🚀 APEX PRO v15.6 LIVE`);
  runScanner();
  cron.schedule('*/60 * * * * *', runScanner);
});
