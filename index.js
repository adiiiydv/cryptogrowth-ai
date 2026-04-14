async function executeOrder(side, symbol, amount) {
    try {
        const pRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        const price = parseFloat(pRes.data.price);

        const execPriceRes = await axios.get(
            `https://api.coindcx.com/exchange/v1/markets/ticker?pair=${symbol}USDT`
        ).catch(() => null);

        const execPrice = execPriceRes?.data?.last_price
            ? parseFloat(execPriceRes.data.last_price)
            : price;

        const safePrice = execPrice || price;
        
        // FIX: Precise rounding for CoinDCX standards
        const precision = (symbol === 'DOGE') ? 4 : 5;
        const qty = Number((amount / safePrice).toFixed(precision));

        const body = {
            side,
            order_type: "market_order",
            market: `${symbol}USDT`,
            total_quantity: qty,
            timestamp: Date.now()
        };

        console.log(`📤 ${side.toUpperCase()} ${symbol} | QTY: ${qty} | PRECISION: ${precision}`);

        await axios.post('https://api.coindcx.com/exchange/v1/orders/create', body, {
            headers: { 
                'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 
                'X-AUTH-SIGNATURE': signDCX(body) 
            }
        });

        console.log(`✅ SUCCESS: ${side} ${symbol}`);
        return { price: safePrice, qty };

    } catch (e) {
        console.log("❌ ORDER ERROR:", e.response?.data || e.message);
        return null;
    }
}
