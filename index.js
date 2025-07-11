const express = require('express');
require('dotenv').config(); // Load .env file
// console.log('Environment variables:', process.env); // Debugging
const cors = require('cors');
const path = require('path');
const app = express();

const allowedOrigins = [
  /^http:\/\/localhost:\d+$/,
  "http://192.168.56.1:3001",
  
  "http://localhost:3001",
  /^http:\/\/192\.168\.56\.1:\d+$/,
  "http://192.168.38.197:8000",  // Add this line'
  "http://192.168.230.155:8000",  // Add this line
  /^http:\/\/192\.168\.38\.197:\d+$/ , // And this for any port

  /^http:\/\/192\.168\.\d+\.\d+:\d+$/, // Allows any 192.168.x.x address
  /^http:\/\/10\.\d+\.\d+\.\d+:\d+$/,  // Allows any 10.x.x.x address (common for local networks)
  /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+:\d+$/, // Allows 172.16-172.31 addresses
];

app.use(cors({
  origin: (origin, callback) => {

    // console.log("Request Origin:", origin); // <-- Log the origin

    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Check if the origin matches any allowed patterns
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

// API route
app.get('/api', (req, res) => {
  res.status(200).json({ message: 'API is running.' });
});

// Auth routes
const authRoutes = require('./routes/auth.js');
app.use('/auth', authRoutes);

 
// 404 Handler
app.use((req, res, next) => {
  res.status(404).json({ message: 'Not Found' });
});

// Start server
app.listen(3001, '0.0.0.0', () => {
  console.log(`Server running here:
  - http://localhost:3001
  - http://192.168.56.1:3001`);
});