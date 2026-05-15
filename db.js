// db.js - Database connection using mysql2/promise
const mysql = require('mysql2/promise');
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ypwi_absensi',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: 'Z',
  dateStrings: true,
  connectTimeout: 30000,
  acquireTimeout: 30000,
  charset: 'utf8mb4'
};

let pool;

const initializeDatabase = async () => {
  try {
    console.log('Initializing database connection...');
    pool = mysql.createPool(dbConfig);
    console.log('Pool created, getting connection...');
    const connection = await pool.getConnection();
    console.log('Database terhubung:', dbConfig.database);
    connection.release();
    console.log('Connection released, database initialized');
    return pool;
  } catch (error) {
    console.error('Gagal terhubung database:', error.message);
    console.error('DB Config:', { ...dbConfig, password: '[HIDDEN]' });
    throw error;
  }
};

const getConnection = async () => {
  if (!pool) {
    await initializeDatabase();
  }
  return pool.getConnection();
};

const query = async (sql, params = []) => {
  const connection = await getConnection();
  try {
    const [results] = await connection.execute(sql, params);
    return results;
  } finally {
    connection.release();
  }
};

const transaction = async (callback) => {
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

module.exports = {
  initializeDatabase,
  query,
  transaction,
  getPool: () => pool
};
