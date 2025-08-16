const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true
}));
app.use(express.json());

// ✅ Serve static html/css/js/images from the project root
app.use(express.static(__dirname));

// Store active sessions (in production, use Redis or database)
const activeSessions = new Map();

// Utility function to get symbol token
function getSymbolToken(symbol) {
    const symbolTokens = {
        'NIFTY': '99926000',
        'BANKNIFTY': '99926009',
        'FINNIFTY': '99926037'
    };
    return symbolTokens[symbol] || '99926000';
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        success: true, 
        message: 'Angel One API Backend is running!',
        timestamp: new Date().toISOString()
    });
});

// Angel One Authentication
app.post('/api/auth/angel-one', async (req, res) => {
    try {
        const { apiKey, clientId, password, totp } = req.body;
        
        if (!apiKey || !clientId || !password || !totp) {
            return res.status(400).json({
                success: false,
                message: 'All fields are required: apiKey, clientId, password, totp'
            });
        }

        const authData = {
            clientcode: clientId,
            password: password,
            totp: totp
        };

        console.log('Attempting Angel One authentication for client:', clientId);

        const response = await axios.post(
            'https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword',
            authData,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-UserType': 'USER',
                    'X-SourceID': 'WEB',
                    'X-ClientLocalIP': req.ip || '127.0.0.1',
                    'X-ClientPublicIP': req.ip || '127.0.0.1',
                    'X-MACAddress': 'fe80::216e:6507:4b90:3719',
                    'X-PrivateKey': apiKey
                },
                timeout: 10000
            }
        );

        if (response.data.status && response.data.data) {
            const sessionData = {
                jwtToken: response.data.data.jwtToken,
                feedToken: response.data.data.feedToken,
                refreshToken: response.data.data.refreshToken,
                clientId: clientId,
                apiKey: apiKey,
                createdAt: new Date()
            };

            // Store session
            activeSessions.set(clientId, sessionData);

            console.log('Authentication successful for client:', clientId);

            res.json({
                success: true,
                data: {
                    jwtToken: sessionData.jwtToken,
                    feedToken: sessionData.feedToken
                },
                message: 'Authentication successful'
            });
        } else {
            throw new Error(response.data.message || 'Authentication failed');
        }
    } catch (error) {
        console.error('Authentication error:', error.response?.data || error.message);
        
        res.status(400).json({
            success: false,
            message: error.response?.data?.message || error.message,
            errorCode: error.response?.data?.errorcode || 'AUTH_FAILED'
        });
    }
});

// Get LTP (Last Traded Price)
app.post('/api/ltp', async (req, res) => {
    try {
        const { symbol, exchange = 'NSE' } = req.body;
        const authToken = req.headers.authorization?.replace('Bearer ', '');
        
        if (!authToken) {
            return res.status(401).json({
                success: false,
                message: 'Authorization token required'
            });
        }

        const ltpData = {
            exchange: exchange,
            tradingsymbol: symbol,
            symboltoken: getSymbolToken(symbol.replace(/\d+/g, ''))
        };

        const response = await axios.post(
            'https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/getLTP',
            ltpData,
            {
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-UserType': 'USER',
                    'X-SourceID': 'WEB'
                },
                timeout: 5000
            }
        );

        res.json({
            success: true,
            data: response.data.data
        });
    } catch (error) {
        console.error('LTP fetch error:', error.response?.data || error.message);
        
        res.status(400).json({
            success: false,
            message: error.response?.data?.message || error.message
        });
    }
});

// Get Options Chain Data
app.get('/api/options/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const { expiry } = req.query;
        const authToken = req.headers.authorization?.replace('Bearer ', '');
        
        if (!authToken) {
            return res.status(401).json({
                success: false,
                message: 'Authorization token required'
            });
        }

        if (!expiry) {
            return res.status(400).json({
                success: false,
                message: 'Expiry date is required'
            });
        }

        console.log(`Fetching options chain for ${symbol} expiry: ${expiry}`);

        // Get current price first
        const ltpResponse = await axios.post(
            'https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/getLTP',
            {
                exchange: 'NSE',
                tradingsymbol: symbol,
                symboltoken: getSymbolToken(symbol)
            },
            {
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-UserType': 'USER',
                    'X-SourceID': 'WEB'
                }
            }
        );

        const currentPrice = ltpResponse.data.data.ltp;

        // For Angel One, we need to fetch individual option contracts
        // This is a simplified approach - in production, you'd want to get all strikes
        const strikes = generateStrikesAroundPrice(currentPrice, symbol);
        const optionsData = [];

        // Fetch data for each strike (batch requests for better performance)
        const promises = strikes.map(async (strike) => {
            try {
                const callSymbol = `${symbol}${formatExpiryForSymbol(expiry)}${strike}CE`;
                const putSymbol = `${symbol}${formatExpiryForSymbol(expiry)}${strike}PE`;

                // In practice, you'd use Angel One's search API to get proper symbol tokens
                // For now, we'll simulate the data structure
                return {
                    strike: strike,
                    callOI: Math.floor(Math.random() * 100000) + 10000,
                    callLTP: Math.random() * 200 + 10,
                    callVolume: Math.floor(Math.random() * 50000),
                    putOI: Math.floor(Math.random() * 100000) + 10000,
                    putLTP: Math.random() * 200 + 10,
                    putVolume: Math.floor(Math.random() * 50000)
                };
            } catch (error) {
                console.error(`Error fetching strike ${strike}:`, error.message);
                return null;
            }
        });

        const results = await Promise.all(promises);
        const validResults = results.filter(result => result !== null);

        res.json({
            success: true,
            data: {
                currentPrice: currentPrice,
                strikes: validResults,
                timestamp: new Date(),
                symbol: symbol,
                expiry: expiry
            }
        });

    } catch (error) {
        console.error('Options chain fetch error:', error.response?.data || error.message);
        
        res.status(400).json({
            success: false,
            message: error.response?.data?.message || error.message,
            errorCode: error.response?.data?.errorcode || 'OPTIONS_FETCH_FAILED'
        });
    }
});

// Refresh token endpoint
app.post('/api/refresh-token', async (req, res) => {
    try {
        const { clientId, refreshToken } = req.body;
        
        const session = activeSessions.get(clientId);
        if (!session) {
            return res.status(401).json({
                success: false,
                message: 'Session not found'
            });
        }

        const response = await axios.post(
            'https://apiconnect.angelbroking.com/rest/auth/angelbroking/jwt/v1/generateTokens',
            {
                refreshToken: refreshToken
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-UserType': 'USER',
                    'X-SourceID': 'WEB',
                    'X-PrivateKey': session.apiKey
                }
            }
        );

        if (response.data.status) {
            session.jwtToken = response.data.data.jwtToken;
            session.feedToken = response.data.data.feedToken;
            activeSessions.set(clientId, session);

            res.json({
                success: true,
                data: {
                    jwtToken: session.jwtToken,
                    feedToken: session.feedToken
                }
            });
        } else {
            throw new Error(response.data.message || 'Token refresh failed');
        }
    } catch (error) {
        console.error('Token refresh error:', error.response?.data || error.message);
        
        res.status(400).json({
            success: false,
            message: error.response?.data?.message || error.message
        });
    }
});

// Helper functions
function generateStrikesAroundPrice(currentPrice, symbol) {
    const strikes = [];
    const step = symbol === 'BANKNIFTY' ? 100 : 50;
    const baseStrike = Math.round(currentPrice / step) * step;
    for (let i = -15; i <= 15; i++) {
        strikes.push(baseStrike + (i * step));
    }
    return strikes;
}

function formatExpiryForSymbol(expiry) {
    const date = new Date(expiry);
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const day = date.getDate().toString().padStart(2, '0');
    const month = months[date.getMonth()];
    const year = date.getFullYear().toString().slice(-2);
    return `${day}${month}${year}`;
}

// Logout endpoint
app.post('/api/logout', async (req, res) => {
    try {
        const { clientId } = req.body;
        const authToken = req.headers.authorization?.replace('Bearer ', '');
        
        if (clientId) activeSessions.delete(clientId);
        if (authToken) {
            await axios.post(
                'https://apiconnect.angelbroking.com/rest/secure/angelbroking/user/v1/logout',
                { clientcode: clientId },
                {
                    headers: {
                        'Authorization': `Bearer ${authToken}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'X-UserType': 'USER',
                        'X-SourceID': 'WEB'
                    }
                }
            ).catch(console.error);
        }
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error.message);
        res.json({ success: true, message: 'Logged out successfully' });
    }
});

// ✅ Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Angel One Backend Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/api/health`);
    console.log('Environment:', process.env.NODE_ENV || 'development');
});

module.exports = app;
