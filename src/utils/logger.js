const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const formatArgs = (args) => {
  return args.map(a => {
    if (a instanceof Error) {
      return JSON.stringify({
        message: a.message,
        stack: a.stack,
        ...a
      });
    }
    return JSON.stringify(a);
  }).join(' ');
};

const logger = {
  info: (message, ...args) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] INFO: ${message} ${formatArgs(args)}\n`;
    console.log(logMessage.trim());
    fs.appendFileSync(path.join(logDir, 'app.log'), logMessage);
  },
  error: (message, ...args) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ERROR: ${message} ${formatArgs(args)}\n`;
    console.error(logMessage.trim());
    fs.appendFileSync(path.join(logDir, 'app.log'), logMessage);
  },
  warn: (message, ...args) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] WARN: ${message} ${formatArgs(args)}\n`;
    console.warn(logMessage.trim());
    fs.appendFileSync(path.join(logDir, 'app.log'), logMessage);
  },
  debug: (message, ...args) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] DEBUG: ${message} ${formatArgs(args)}\n`;
    if (process.env.NODE_ENV === 'development') {
      console.log(logMessage.trim());
      fs.appendFileSync(path.join(logDir, 'app.log'), logMessage);
    }
  },
};

module.exports = logger;
