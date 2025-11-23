const express = require('express');
require('dotenv').config();
const cors = require('cors');
const axios = require('axios');
const path = require('path'); // Add this import
const fs = require('fs'); // Add this import

const app = express();

// Your existing CORS configuration
const allowedOrigins = [
  /^http:\/\/192\.168\.56\.1:\d+$/,
  "http://127.0.0.1:8000/",
  /^http:\/\/192\.168\.38\.197:\d+$/,
  /^http:\/\/localhost:\d+$/,
  "https://agritrack-theta.vercel.app",
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




// Serve static files from public directory
app.use(express.static('public'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Self-ping function with time limit
let selfPingInterval;
let selfPingStartTime = null;
const MAX_SELF_PING_DURATION = 4 * 60 * 60 * 1000; // 4 hours in milliseconds

const startSelfPing = () => {
  // Clear any existing interval
  if (selfPingInterval) {
    clearInterval(selfPingInterval);
  }
  
  selfPingStartTime = Date.now();
  console.log('Starting self-ping service for 4 hours...');
  
  const selfPing = async () => {
    // Check if we've exceeded the 4-hour limit
    const elapsedTime = Date.now() - selfPingStartTime;
    if (elapsedTime >= MAX_SELF_PING_DURATION) {
      clearInterval(selfPingInterval);
      console.log('Self-ping service stopped after 4 hours');
      return;
    }
    
    try {
      console.log('Self-pinging to keep server awake...');
      const response = await axios.get(`http://localhost:${PORT}/wakeup`, {
        timeout: 5000
      });
      console.log('Self-ping successful:', response.data);
    } catch (error) {
      console.log('Self-ping failed (silent) - server may be starting up');
    }
  };
  
  // Run immediately and then every 14 minutes (Render timeout is 15 min)
  selfPing();
  selfPingInterval = setInterval(selfPing, 11 * 60 * 1000);
};

// Function to ping Aicrop service
const pingAicropService = async () => {
  try {
    console.log('Pinging Aicrop service to keep it awake...');
    await axios.get('https://aicrop.onrender.com/api/v1', { 
      timeout: 10000
    });
    console.log('Aicrop service ping successful');
  } catch (error) {
    console.log('Aicrop service ping failed (silent) - service may be cold starting');
  }
};

// Set up Aicrop ping interval
const AICROP_PING_INTERVAL = 13 * 60 * 1000; // 13 minutes
let aicropPingInterval;



// APK download endpoint
app.get('/download/apk/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'public', 'apk', filename);
  
  // Check if file exists
  if (fs.existsSync(filePath)) {
    // Set headers for file download
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    
    // Stream the file
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  } else {
    res.status(404).json({ message: 'APK file not found' });
  }
});


// API route
app.get('/api', (req, res) => {
  res.status(200).json({ message: 'API is running.' });
});

// Wake-up endpoint - also starts self-ping when called
app.get('/wakeup', (req, res) => {
  // Start self-ping if not already running or if it's been more than 4 hours
  if (!selfPingStartTime || (Date.now() - selfPingStartTime) >= MAX_SELF_PING_DURATION) {
    startSelfPing();
    pingAicropService();
  }
  
  res.status(200).json({ 
    status: 'awake', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    self_ping_active: selfPingStartTime !== null && 
                     (Date.now() - selfPingStartTime) < MAX_SELF_PING_DURATION
  });
  console.log('Wake-up endpoint hit');
});

// Manual control endpoints
app.post('/self-ping/start', (req, res) => {
  startSelfPing();
  res.status(200).json({ 
    status: 'started',
    message: 'Self-ping service started for 4 hours'
  });
});

app.post('/self-ping/stop', (req, res) => {
  if (selfPingInterval) {
    clearInterval(selfPingInterval);
    selfPingStartTime = null;
    console.log('Self-ping service manually stopped');
    res.status(200).json({ status: 'stopped' });
  } else {
    res.status(200).json({ status: 'not-running' });
  }
});

app.get('/self-ping/status', (req, res) => {
  const active = selfPingStartTime !== null && 
                (Date.now() - selfPingStartTime) < MAX_SELF_PING_DURATION;
  
  let remainingTime = 0;
  if (active) {
    remainingTime = MAX_SELF_PING_DURATION - (Date.now() - selfPingStartTime);
  }
  
  res.status(200).json({ 
    active,
    start_time: selfPingStartTime ? new Date(selfPingStartTime).toISOString() : null,
    remaining_minutes: Math.round(remainingTime / (60 * 1000))
  });
});

// Auth routes and other routes...
const authRoutes = require('./routes/auth.js');
app.use('/auth', authRoutes);

const yieldsRoutes = require('./routes/yields.js');
app.use('/yields', yieldsRoutes);

const assocsRoutes = require('./routes/assocs.js');
app.use('/assocs', assocsRoutes);

const reportRoutes = require('./routes/reports.js');
app.use('/reports', reportRoutes);

const farmerRoutes = require('./routes/farmers.js');
app.use('/farmers', farmerRoutes);

const sectorRoutes = require('./routes/sectors.js');
app.use('/sectors', sectorRoutes);

const farmtRoutes = require('./routes/farms.js');
app.use('/farms', farmtRoutes);

const productRoutes = require('./routes/products.js');
app.use('/products', productRoutes);

// 404 Handler
app.use((req, res, next) => {
  res.status(404).json({ message: 'Not Found' });
});

const PORT = process.env.PORT || 3001;

// Start server with periodic pinging
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Available at:
  - http://localhost:${PORT}
  - http://192.168.56.1:${PORT}`);
  
  // Start Aicrop pinging (every 13 minutes)
  aicropPingInterval = setInterval(pingAicropService, AICROP_PING_INTERVAL);
  
  // Initial Aicrop ping
  setTimeout(pingAicropService, 5000);
  
  // Note: We don't automatically start self-ping on server start
  // It will only start when the /wakeup endpoint is called
});

// Clean up intervals when server stops
const cleanup = () => {
  if (selfPingInterval) clearInterval(selfPingInterval);
  if (aicropPingInterval) clearInterval(aicropPingInterval);
  server.close(() => {
    console.log('Server terminated');
  });
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
