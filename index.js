const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const { RSI, EMA } = require('technicalindicators');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Apex Pro: Stable Execution 🚀'));
app.listen(PORT, () => console.log(`✅ System Live on Port ${PORT}`));

let WATCHLIST = ['DOGE', 'MATIC', 'ADA', 'XRP'];
let activeTrades = [];
const MAX_TRADES = 3;
let lastTradeTime = 0;
const COOLDOWN = 2 * 60 * 1000; 

const signDCX = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY)
        .update(payload)
        .digest('hex');
};

const runMultiScanner = async () => {
    for (let i = activeTrades.length - 1; i >= 0; i--) {
        await checkTrailingExit(activeTrades[i], i);
    }

    if (activeTrades.length >= MAX_TRADES) return;

    let balance = 0;
    try {
        const body = { timestamp: Date.now() };
        const balRes = await axios.post(
            'https://api.coindcx.com/exchange/v1/users/balances',
            body,
            {
                headers: {
                    'X-AUTH-APIKEY': process.env.COINDCX_API_KEY,
                    'X-AUTH-SIGNATURE': signDCX(body)
                }
            }
        );

        const usdtData = balRes.data.find(
            b => b.currency === 'USDT' || b.asset === 'USDT'
        );

        if (usdtData) {
            balance = parseFloat(usdtData.balance) - parseFloat(usdtData.locked_balance || 0);
        }
    } catch (e) {
        console.log("⚠️ Balance fetch failed");
    }

    console.log(`\n--- 🔍 SCAN | Available: ${balance.toFixed(2)} USDT ---`);

    const shuffledList = [...WATCHLIST].sort(() => Math.random() - 0.5);

    for (const coin of shuffledList) {
        if (activeTrades.length >= MAX_TRADES) break;
        if (activeTrades.find(t => t.symbol === coin)) continue;

        try {
            const res = await axios.get(
                `https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=1m&limit=100`
            );

            const prices = res.data.map(d => parseFloat(d[4]));
            const volumes = res.data.map(d => parseFloat(d[5]));

            const rsi = RSI.calculate({ values: prices, period: 14 }).pop();
            const ema9 = EMA.calculate({ values: prices, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: prices, period: 21 }).pop();

            const avgVolume = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
            const currentVolume = volumes[volumes.length - 1];

            console.log(
                `🧠 CHECK → ${coin} | RSI:${rsi.toFixed(1)} | EMA:${ema9 >= ema21} | VOL:${currentVolume > (avgVolume * 0.8)} | COOLDOWN:${(Date.now() - lastTradeTime > COOLDOWN)}`
            );

            if (
                rsi < 55 &&
                ema9 >= ema21 &&
                currentVolume > (avgVolume * 0.8) &&
                (Date.now() - lastTradeTime > COOLDOWN)
            ) {
                const tradeAmount = Math.min(balance - 0.1, Math.max(4, balance * 0.9)).toFixed(2);

                if (parseFloat(tradeAmount) < 4 || balance < 4) {
                    continue;
                }

                console.log(`🎯 SIGNAL: Buying ${coin} with ${tradeAmount} USDT`);

                const bought = await executeOrder("buy", coin, tradeAmount);

                if (bought) {
                    activeTrades.push({
                        symbol: coin,
                        entry: bought.price,
                        qty: bought.qty,
                        highestPrice: bought.price
                    });
                    lastTradeTime = Date.now();
                }
            }
        } catch (e) {
            continue;
        }
    }
};

async function checkTrailingExit(trade, index) {
    try {
        const res = await axios.get(
            `https://api.binance.com/api/v3/ticker/price?symbol=${trade.symbol}USDT`
        );

        const currentPrice = parseFloat(res.data.price);
        if (currentPrice > trade.highestPrice) trade.highestPrice = currentPrice;

        const dropFromTop =
            ((trade.highestPrice - currentPrice) / trade.highestPrice) * 100;

        const totalGain =
            ((currentPrice - trade.entry) / trade.entry) * 100;

        console.log(`📈 ${trade.symbol} | Gain: ${totalGain.toFixed(2)}%`);

        if ((totalGain > 0.5 && dropFromTop > 0.25) || totalGain <= -0.7) {
            console.log(`🚪 SELL SIGNAL: ${trade.symbol}`);

            const sold = await executeOrder(
                "sell",
                trade.symbol,
                (trade.qty * currentPrice).toFixed(2),
                trade.qty
            );

            if (sold) activeTrades.splice(index, 1);
        }
    } catch (e) {
        console.log(`❌ Exit check failed for ${trade.symbol}`);
    }
}

async function executeOrder(side, symbol, amount, exactQty = null) {
    try {
        const pRes = await axios.get(
            `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`
        );

        const price = parseFloat(pRes.data.price);

        const qty = exactQty
            ? exactQty
            : Number((amount / price).toFixed(5));

        const body = {
            side,
            order_type: "market_order",
            market: `${symbol}USDT`,
            total_quantity: qty,
            timestamp: Date.now()
        };

        console.log("📤 ORDER BODY:", body);

        await axios.post(
            'https://api.coindcx.com/exchange/v1/orders/create',
            body,
            {
                headers: {
                    'X-AUTH-APIKEY': process.env.COINDCX_API_KEY,
                    'X-AUTH-SIGNATURE': signDCX(body)
                }
            }
        );

        console.log(`✅ Order placed: ${side} ${symbol}`);
        return { price, qty };
    } catch (err) {
        console.log("❌ FULL ERROR:", err.response?.data || err.message);
        return null;
    }
}

cron.schedule('*/1 * * * *', runMultiScanner);
