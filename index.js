const runMultiScanner = async () => {
    if (activeTrade) {
        await checkExit(activeTrade);
        return;
    }

    console.log(`--- 🔍 NEW SCAN START: ${new Date().toLocaleTimeString()} ---`);

    for (const coin of WATCHLIST) {
        const prices = await getOhlcv(coin);
        if (!prices) {
            console.log(`⚠️ ${coin}: Data unavailable`);
            continue;
        }

        const rsi = RSI.calculate({ values: prices, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: prices, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: prices, period: 21 }).pop();
        const currentPrice = prices[prices.length - 1];

        // THIS IS THE LINE YOU WANTED:
        console.log(`📡 [${coin}] Price: ${currentPrice.toFixed(2)} | RSI: ${rsi.toFixed(2)} | EMA9: ${ema9.toFixed(2)}`);

        // --- DYNAMIC SIGNAL DETECTION ---
        if (rsi < 30 && ema9 > ema21) {
            console.log(`🎯 !!! SIGNAL DETECTED !!! for ${coin}`);
            const bought = await executeOrder("buy", coin, 1.88); 
            if (bought) {
                activeTrade = { symbol: coin, entry: bought.price, qty: bought.qty };
                break; 
            }
        }
    }
    console.log(`--- 🏁 SCAN COMPLETE ---`);
};
// Add this at the bottom of your file
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is Running 🚀'));
app.listen(PORT, () => {
    console.log(`✅ Server is live on port ${PORT}`);
});
