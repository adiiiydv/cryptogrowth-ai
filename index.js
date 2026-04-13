// --- DYNAMIC CONFIG ---
let WATCHLIST = ['SOL', 'BTC', 'ETH', 'DOGE', 'MATIC', 'ADA', 'XRP'];
const DISCOVERY_LIMIT = 3; // Number of "discovered" coins to add

// --- 1. RESEARCH FUNCTION (Finds new potential coins) ---
const researchNewCoins = async () => {
    try {
        console.log("🕵️ Researching new high-potential coins...");
        // Fetch 24hr stats for all symbols
        const res = await axios.get('https://api.binance.com/api/v3/ticker/24hr');
        
        // Filter for USDT pairs, high volume, and price action
        const topPotentials = res.data
            .filter(t => t.symbol.endsWith('USDT'))
            .filter(t => parseFloat(t.quoteVolume) > 10000000) // Only coins with >10M Volume
            .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent)) // Sort by gainers
            .slice(0, DISCOVERY_LIMIT)
            .map(t => t.symbol.replace('USDT', ''));

        // Reset Watchlist: Base coins + New discovered gems
        WATCHLIST = ['SOL', 'BTC', 'ETH', 'DOGE', 'MATIC', 'ADA', 'XRP', ...topPotentials];
        console.log(`✅ New Watchlist Updated: ${WATCHLIST.join(', ')}`);
    } catch (e) {
        console.log("❌ Research failed, keeping current list.");
    }
};

// --- 2. UPDATED SCANNER ---
const runMultiScanner = async () => {
    if (activeTrade) {
        await checkExit(activeTrade);
        return;
    }

    // Fetch Wallet Balance first
    let currentUSDT = await getBalance(); 

    console.log(`--- 🔍 SCAN | Wallet: ${currentUSDT} USDT | Targets: ${WATCHLIST.length} ---`);

    for (const coin of WATCHLIST) {
        const prices = await getOhlcv(coin);
        if (!prices) continue;

        const rsi = RSI.calculate({ values: prices, period: 14 }).pop();
        const ema9 = EMA.calculate({ values: prices, period: 9 }).pop();
        const ema21 = EMA.calculate({ values: prices, period: 21 }).pop();
        const currentPrice = prices[prices.length - 1];

        console.log(`📡 [${coin}] P: ${currentPrice.toFixed(4)} | RSI: ${rsi.toFixed(2)} | EMA9: ${ema9.toFixed(2)}`);

        // Invest if signal is sure (RSI Oversold + EMA Bullish Cross)
        if (rsi < 30 && ema9 > ema21) {
            console.log(`🎯 SURE SIGNAL: Investing in ${coin}!`);
            const bought = await executeOrder("buy", coin, (parseFloat(currentUSDT) * 0.98).toFixed(2));
            if (bought) {
                activeTrade = { symbol: coin, entry: bought.price, qty: bought.qty };
                break;
            }
        }
    }
};

// --- 3. SCHEDULE RESEARCH ---
// Research new potential coins every 1 hour
cron.schedule('0 * * * *', researchNewCoins); 
// Scan market every 1 minute
cron.schedule('*/1 * * * *', runMultiScanner);
