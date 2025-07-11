const mysql = require('mysql2');

const db = mysql.createConnection({
  // host: "localhost",
  // user: "root",
  // password: "",
  // database: "agritrack" 
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: process.env.MYSQL_PORT || 3306 
});

db.connect((err) => {
  if (err) {
    console.error('Error connecting to MySQL:', err);
    return;
  }
  console.log('Connected to MySQL database');
});

module.exports = db;  // Exporting just the db object
