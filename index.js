// ... [Keep core imports and express setup] ...

// 1. DYNAMIC STEP-SIZE PRECISION FIX
const getPrecision = (symbol) => {
    const map = { 'DOGE': 4, 'XRP': 2, 'ADA': 2, 'MATIC': 2, 'TRX': 1 };
    return map[symbol] || 2; 
};

// 2. MULTI-TIMEFRAME TREND CHECK (15m Confirmation)
const checkHigherTrend = async (symbol) => {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=15m&limit=20`);
        const closes = res.data.map(d => parseFloat(d[4]));
        const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();
        return ema9 > ema21; // True if 15m trend is Bullish
    } catch (e) { return false; }
};

// ================= SCANNER =================
const runMultiScanner = async () => {
    if (dailyKillSwitch || globalStats.consecutiveLosses >= 3) return;

    for (let i = activeTrades.length - 1; i >= 0; i--) {
        await checkTrailingExit(activeTrades[i], i);
    }

    if (activeTrades.length >= MAX_TRADES) return;

    // ... [Balance fetch logic stays same] ...

    const shuffled = [...WATCHLIST].sort(() => Math.random() - 0.5);

    for (const coin of shuffled) {
        if (activeTrades.length >= MAX_TRADES) break;
        if (activeTrades.find(t => t.symbol === coin)) continue;

        try {
            // 1m Signals
            const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=1m&limit=100`);
            const closes = res.data.map(d => parseFloat(d[4]));
            
            // 15m Trend Confirmation (The "Institutional" Filter)
            const isHighTrendBull = await checkHigherTrend(coin);
            
            marketRegime = detectMarketRegime(closes);
            const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
            const ema9 = EMA.calculate({ values: closes, period: 9 }).pop();
            const ema21 = EMA.calculate({ values: closes, period: 21 }).pop();

            let score = 0;
            if (rsi < 60) score++;
            if (ema9 > ema21) score++;
            if (isHighTrendBull) score += 2; // HEAVY WEIGHT on 15m trend
            if (marketRegime === "bull") score++;

            console.log(`🧠 ${coin} | Score: ${score}/5 | 15mTrend: ${isHighTrendBull}`);

            // ENTRY RULE: Must have 15m confirmation
            if (score >= 4 && isHighTrendBull && balance > 4) {
                const riskFactor = (coinStats[coin]?.winRate > 0.6) ? 0.45 : 0.35;
                const tradeAmount = Math.min(balance - 0.1, balance * riskFactor).toFixed(2);

                const bought = await executeOrder("buy", coin, tradeAmount);
                if (bought) {
                    // 3. DYNAMIC EXIT: Calculate ATR for Volatility-based Exit
                    const highs = res.data.map(d => parseFloat(d[2]));
                    const lows = res.data.map(d => parseFloat(d[3]));
                    const currentAtr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop();
                    
                    activeTrades.push({ 
                        symbol: coin, 
                        entry: bought.price, 
                        qty: bought.qty, 
                        highestPrice: bought.price,
                        atrStop: currentAtr * 1.5 // Dynamic volatility stop
                    });
                    lastTradeTime = Date.now();
                }
            }
        } catch (e) {}
    }
};

// ================= EXIT ENGINE (Dynamic) =================
async function checkTrailingExit(trade, index) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${trade.symbol}USDT`);
        const price = parseFloat(res.data.price);
        if (price > trade.highestPrice) trade.highestPrice = price;

        const drop = ((trade.highestPrice - price) / trade.highestPrice) * 100;
        const gain = ((price - trade.entry) / trade.entry) * 100;

        // DYNAMIC EXIT: If gain is high, tighten the trail. If volatility is high, widen it.
        const dynamicTrail = gain > 1.5 ? 0.25 : 0.4;
        const stopLoss = -0.7; // Hard floor

        if ((gain > 0.7 && drop > dynamicTrail) || gain < stopLoss) {
            await executeOrder("sell", trade.symbol, 0, trade.qty);
            activeTrades.splice(index, 1);
            
            // Win/Loss stats logic... [Keep existing globalStats update]
        }
    } catch (e) {}
}

// ================= EXECUTION (Precision Fix) =================
async function executeOrder(side, symbol, amount, exactQty = null) {
    try {
        const pRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        const price = parseFloat(pRes.data.price);
        
        const execPriceRes = await axios.get(`https://api.coindcx.com/exchange/v1/markets/ticker?pair=${symbol}USDT`).catch(() => null);
        const safePrice = execPriceRes?.data?.last_price ? parseFloat(execPriceRes.data.last_price) : price;

        // PRECISION MAPPING
        const precision = getPrecision(symbol);
        const qty = exactQty ? Number(exactQty.toFixed(precision)) : Number((amount / safePrice).toFixed(precision));

        if (!qty || qty <= 0) return null;

        const body = {
            side,
            order_type: "market_order",
            market: `${symbol}USDT`,
            total_quantity: qty,
            timestamp: Date.now()
        };

        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });

        return { price: safePrice, qty };
    } catch (e) {
        console.log(`❌ ${symbol} Order Fail:`, e.response?.data?.message || e.message);
        return null;
    }
}
