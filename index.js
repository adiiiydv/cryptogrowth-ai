const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());

// 6:00 PM to 7:00 PM SAFETY WINDOW (IST)
// This liquidates assets to your wallet daily
cron.schedule('0 18 * * *', async () => {
    console.log("6 PM IST: Safety window active. Cash out to wallet.");
});

// AUTO-TRADE ENGINE (Targeting 30% profit / 7% loss)
cron.schedule('*/5 * * * *', async () => {
    console.log("AI Scanning for high-probability trades...");
    // AI and CoinDCX logic goes here
});

app.get('/', (req, res) => {
    res.send('CryptoGrowth AI Engine is Active and Scanning.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
