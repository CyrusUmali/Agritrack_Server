const express = require('express');
require('dotenv').config();
const cors = require('cors');
const axios = require('axios');

const app = express();

// Your existing CORS configuration
const allowedOrigins = [
  /^http:\/\/192\.168\.56\.1:\d+$/,
  "http://127.0.0.1:8000/",
  /^http:\/\/192\.168\.38\.197:\d+$/,
  /^http:\/\/localhost:\d+$/,
  "https://cyrusumali.github.io",
  /^http:\/\/192\.168\.\d+\.\d+:\d+$/,
  /^http:\/\/10\.\d+\.\d+\.\d+:\d+$/,
  /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+:\d+$/,
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(pattern => 
      typeof pattern === 'string' 
        ? origin === pattern 
        : pattern.test(origin)
    )) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Function to ping Aicrop service
const pingAicropService = async () => {
  try {
    console.log('Pinging Aicrop service to keep it awake...');
    await axios.get('https://aicrop.onrender.com/api/v1', { 
      timeout: 10000 // 10 second timeout
    });
    console.log('Aicrop service ping successful');
  } catch (error) {
    console.log('Aicrop service ping failed (silent) - service may be cold starting');
  }
};

// Set up periodic pinging (every 5 minutes)
const PING_INTERVAL = 13 * 60 * 1000; // 5 minutes in milliseconds
let pingInterval;

// API route
app.get('/api', (req, res) => {
  res.status(200).json({ message: 'API is running.' });
});

// Auth routes
const authRoutes = require('./routes/auth.js');
app.use('/auth', authRoutes);

// Yields routes
const yieldsRoutes = require('./routes/yields.js');
app.use('/yields', yieldsRoutes);

  
// Assocs routes
const assocsRoutes = require('./routes/assocs.js');
app.use('/assocs', assocsRoutes);

// Report routes
const reportRoutes = require('./routes/reports.js');
app.use('/reports', reportRoutes);


// Farmer routes
const farmerRoutes = require('./routes/farmers.js');
app.use('/farmers', farmerRoutes);


// Sector routes
const sectorRoutes = require('./routes/sectors.js');
app.use('/sectors', sectorRoutes);


// Farm routes
const farmtRoutes = require('./routes/farms.js');
app.use('/farms', farmtRoutes);

// Product routes
const productRoutes = require('./routes/products.js');
app.use('/products', productRoutes);

// Wake-up endpoint
app.get('/wakeup', (req, res) => {
  res.status(200).json({ status: 'awake' });
  console.log('Wake-up endpoint hit');
});

// 404 Handler
app.use((req, res, next) => {
  res.status(404).json({ message: 'Not Found' });
});

// Start server with periodic pinging
const server = app.listen(3001, '0.0.0.0', () => {
  console.log(`Server running here:
  - http://localhost:3001
  - http://192.168.56.1:3001`);
  
  // Start periodic pinging
  pingInterval = setInterval(pingAicropService, PING_INTERVAL);
  
  // Initial ping 
setTimeout(pingAicropService, 15000); // Wait 15s after server start

});

// Clean up interval when server stops
process.on('SIGTERM', () => {
  clearInterval(pingInterval);
  server.close(() => {
    console.log('Server terminated');
  });
});

process.on('SIGINT', () => {
  clearInterval(pingInterval);
  server.close(() => {
    console.log('Server terminated');
  });
});