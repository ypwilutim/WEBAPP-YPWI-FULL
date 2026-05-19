const fs = require('fs');
const path = require('path');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logFile = path.join(logsDir, 'app.log');

function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(logFile, logMessage);
}

function requestLogger(req, res, next) {
  const timestamp = new Date().toISOString();
  const logData = {
    timestamp,
    method: req.method,
    url: req.originalUrl,
    headers: {
      authorization: req.headers['authorization'] || 'NONE',
      'content-type': req.headers['content-type'] || 'NONE'
    },
    body: req.body || {},
    query: req.query || {}
  };

  console.log('=== [ROBUST LOGGER] INCOMING REQUEST ===');
  console.log(JSON.stringify(logData, null, 2));
  console.log('=======================================');

  logToFile(`REQUEST: ${JSON.stringify(logData)}`);

  // Log response on finish for errors
  const originalSend = res.send;
  res.send = function(data) {
    if (res.statusCode >= 500) {
      console.error('=== [ERROR 500] STACK TRACE ===');
      console.error(new Error('Server Error at ' + req.method + ' ' + req.originalUrl).stack);
      console.error('Response:', data);
      logToFile(`ERROR 500: ${req.method} ${req.originalUrl} - ${data}`);
    }
    return originalSend.apply(this, arguments);
  };

  next();
}

module.exports = requestLogger;
