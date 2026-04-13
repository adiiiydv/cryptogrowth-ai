const runMultiScanner = async () => {
    if (activeTrade) {
        await checkExit(activeTrade);
        return;
    }

    // --- NEW: FETCH LIVE USDT BALANCE ---
    let currentUSDT = "0.00";
    try {
        const body = { timestamp: Date.now() };
        const balanceRes = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', body, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signDCX(body) }
        });
        const usdtData = balanceRes.data.find(b => b.currency === 'USDT' || b.asset === 'USDT');
        currentUSDT = usdtData ? parseFloat(usdtData.balance).toFixed(2) : "0.00";
    } catch (e) {
        currentUSDT = "Error";
    }

    console.log(`--- 🔍 SCAN START | Wallet: ${currentUSDT} USDT | ${new Date().toLocaleTimeString()} ---`);

    for (const coin of WATCHLIST) {
        const prices = await getOhlcv(coin);
        if (!prices) continue;

        const rsi = RSI.calculate({ values: prices, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: prices, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: prices, period: 21 }).pop();
        const currentPrice = prices[prices.length - 1];

        // Shows balance context in every line
        console.log(`📡 [${coin}] P: ${currentPrice.toFixed(2)} | RSI: ${rsi.toFixed(2)} | EMA9: ${ema9.toFixed(2)}`);

        if (rsi < 30 && ema9 > ema21) {
            console.log(`🎯 SIGNAL for ${coin}! Attempting trade...`);
            const bought = await executeOrder("buy", coin, (parseFloat(currentUSDT) * 0.98).toFixed(2)); 
            if (bought) {
                activeTrade = { symbol: coin, entry: bought.price, qty: bought.qty };
                break; 
            }
        }
    }
};
