// ... (Your imports)

const runTradeEngine = async () => {
    console.log(`--- Engine Run at ${new Date().toLocaleTimeString()} ---`);
    const hasFunds = await getBalance();
    
    if (!hasFunds) {
        console.log("No Balance Found. The bot cannot buy without INR in the wallet.");
        return;
    }

    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=inr&order=price_change_percentage_24h_desc&per_page=15');
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        // This prompt forces the AI to stop "thinking" and just PICK a coin.
        const prompt = "FORCE BUY MODE: Pick the #1 coin from this list for a 30% scalp. Output ONLY JSON {coin, target, stoploss}: " + JSON.stringify(res.data.slice(0,5));

        const result = await model.generateContent(prompt);
        console.log("DECISION MADE:", result.response.text());
    } catch (error) {
        console.log("Rate limit hit. Waiting for next cycle.");
    }
};

// 5 minutes is the safest "fast" speed.
cron.schedule('*/5 * * * *', runTradeEngine);
// ...
