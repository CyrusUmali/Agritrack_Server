const express = require('express');
require('dotenv').config();
const cors = require('cors');
const path = require('path');
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

// Simple wake-up call function
const wakeUpRenderService = () => {
  console.log('Attempting to wake up aicrop service...');
  axios.get('https://aicrop.onrender.com/api/v1', { 
    timeout: 10000 // 10 second timeout
  })
  .then(() => console.log('Wake-up call succeeded (or service was already awake)'))
  .catch(() => console.log('Wake-up call failed (silent) - service may be cold starting'));
};

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

// Report routes
const reportRoutes = require('./routes/reports.js');
app.use('/reports', reportRoutes);

// 404 Handler
app.use((req, res, next) => {
  res.status(404).json({ message: 'Not Found' });
});

// Start server with wake-up call
app.listen(3001, '0.0.0.0', () => {
  console.log(`Server running here:
  - http://localhost:3001
  - http://192.168.56.1:3001`);
  
  // Trigger wake-up call in background
  wakeUpRenderService();
});