// ... (keep your top variables the same)

const runTradeEngine = async () => {
    console.log(`--- Fast Scan: ${new Date().toLocaleTimeString()} ---`);
    
    const hasFunds = await getBalance();
    if (!hasFunds) {
        console.log("No INR detected yet. Check CoinDCX Wallet.");
        return;
    }

    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=inr&order=price_change_percentage_24h_desc&per_page=15');
        
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        // NEW PROMPT: Tells the AI to be less picky and pick the best coin NOW.
        const prompt = "TURBO MODE: Pick the best coin for a quick scalp from this list immediately. Be aggressive. Return JSON {coin, target, stoploss}: " + JSON.stringify(res.data.slice(0,10));

        const result = await model.generateContent(prompt);
        console.log("FAST DECISION:", result.response.text());
    } catch (error) {
        console.log("AI Busy - retrying in 2 mins.");
    }
};

// CHANGED: Now runs every 2 minutes instead of 10
cron.schedule('*/2 * * * *', runTradeEngine);

// ... (keep the rest the same)
