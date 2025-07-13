const mysql = require('mysql2/promise'); // Note the /promise suffix

// Create a connection pool instead of a single connection
const pool = mysql.createPool({

  // host: "localhost",
  // user: "root",
  // password: "",n
  // database: "agritrack" 
  host: process.env.MYSQL_HOST || "localhost",
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "agritrack",
  port: process.env.MYSQL_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10, // Adjust based on your needs
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
});

// Test the pool connection
pool.getConnection()
  .then(connection => {
    console.log('Connected to MySQL database');
    connection.release(); // Release the connection back to the pool
  })
  .catch(err => {
    console.error('Error connecting to MySQL:', err);
  });

module.exports = pool;