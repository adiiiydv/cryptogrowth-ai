const getUSDTBalance = async () => {
    try {
        const timeStamp = Date.now();
        const signature = crypto.createHmac('sha256', process.env.COINDCX_SECRET_KEY).update(Buffer.from(JSON.stringify({"timestamp": timeStamp}))).digest('hex');

        const res = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', {"timestamp": timeStamp}, {
            headers: { 'X-AUTH-APIKEY': process.env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': signature }
        });

        // Loop through all assets to find Tether
        const usdt = res.data.find(asset => asset.currency === 'USDT');
        const balance = usdt ? parseFloat(usdt.balance) : 0;
        
        console.log(`LOG: API found ${balance} USDT in your wallet.`);
        return balance;
    } catch (err) {
        console.log("LOG: API Key rejected by CoinDCX. Check your Secret Key/Permissions.");
        return 0;
    }
};
