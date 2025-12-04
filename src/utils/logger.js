const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logger = {
  info: (message, ...args) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] INFO: ${message} ${args.map(a => JSON.stringify(a)).join(' ')}\n`;
    console.log(logMessage.trim());
    fs.appendFileSync(path.join(logDir, 'app.log'), logMessage);
  },
  error: (message, ...args) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ERROR: ${message} ${args.map(a => JSON.stringify(a)).join(' ')}\n`;
    console.error(logMessage.trim());
    fs.appendFileSync(path.join(logDir, 'app.log'), logMessage);
  },
  warn: (message, ...args) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] WARN: ${message} ${args.map(a => JSON.stringify(a)).join(' ')}\n`;
    console.warn(logMessage.trim());
    fs.appendFileSync(path.join(logDir, 'app.log'), logMessage);
  },
  debug: (message, ...args) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] DEBUG: ${message} ${args.map(a => JSON.stringify(a)).join(' ')}\n`;
    if (process.env.NODE_ENV === 'development') {
      console.log(logMessage.trim());
      fs.appendFileSync(path.join(logDir, 'app.log'), logMessage);
    }
  },
};

module.exports = logger;
