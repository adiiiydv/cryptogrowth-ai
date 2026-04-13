const runMultiScanner = async () => {
    if (activeTrade) {
        await checkExit(activeTrade);
        return;
    }

    let currentUSDT = "4.01"; // Using your verified balance
    console.log(`--- 🚀 ACTIVE HUNT | Wallet: ${currentUSDT} USDT | ${new Date().toLocaleTimeString()} ---`);

    for (const coin of WATCHLIST) {
        const prices = await getOhlcv(coin);
        if (!prices || prices.length < 21) continue;

        const rsi = RSI.calculate({ values: prices, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: prices, period: 9 }).pop();
        const currentPrice = prices[prices.length - 1];

        console.log(`📡 [${coin}] RSI: ${rsi.toFixed(2)} | P: ${currentPrice.toFixed(2)}`);

        // AGGRESSIVE BUY: RSI below 32 (Easier to hit than 30)
        // Removed the strict EMA Cross to ensure it BUYS during the dip
        if (rsi < 32) {
            console.log(`💰 SIGNAL DETECTED! Buying ${coin} now...`);
            
            // USE 3.0 USDT per trade (Ensures we stay above the exchange minimum)
            const tradeAmount = 3.0; 
            const bought = await executeOrder("buy", coin, tradeAmount);
            
            if (bought) {
                activeTrade = { symbol: coin, entry: bought.price, qty: bought.qty };
                console.log(`✅ SUCCESS: Bought ${coin} at ${bought.price}`);
                break; 
            }
        }
    }
};
