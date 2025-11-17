const logger = require('./logger');

function validateConfig() {
  const requiredEnvVars = [
    'DATABASE_URL',
    'JWT_SECRET',
  ];

  const missing = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missing.length > 0) {
    logger.error(`Missing required environment variables: ${missing.join(', ')}`);
    logger.error('Please check your .env file and ensure all required variables are set.');
    process.exit(1);
  }

  if (process.env.JWT_SECRET === 'your-secret-key-change-this-in-production') {
    logger.error('JWT_SECRET is set to the default value. This is a security risk!');
    logger.error('Please set a strong, unique JWT_SECRET in your .env file.');
    process.exit(1);
  }

  if (process.env.SESSION_SECRET === 'your-session-secret-change-this') {
    logger.warn('SESSION_SECRET is set to the default value. Consider changing it for production.');
  }

  logger.info('✅ Configuration validated successfully');
}

module.exports = validateConfig;
