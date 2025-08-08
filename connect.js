const mysql = require('mysql2/promise');  // Note the /promise

const pool = mysql.createPool({
   host: "localhost",  
   user: "root",
  password: "",
   database: "agritrack" ,
  // host: process.env.MYSQL_HOST ,
  // user: process.env.MYSQL_USER  ,
  // password: process.env.MYSQL_PASSWORD  , 
  // database: process.env.MYSQL_DATABASE  ,
  port: process.env.MYSQL_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0
});

// Test connection
pool.getConnection()
  .then(connection => {
    console.log('Connected to MySQL database');
    connection.release();
  })
  .catch(err => {
    console.error('MySQL connection error:', err);
  });

module.exports = pool;