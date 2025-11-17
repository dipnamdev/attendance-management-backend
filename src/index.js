const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const cron = require('node-cron');
require('dotenv').config();

const validateConfig = require('./utils/configValidation');
const { connectRedis } = require('./config/redis');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const logger = require('./utils/logger');
const runDailyAggregation = require('./jobs/dailyAggregation');

validateConfig();

const authRoutes = require('./routes/auth');
const attendanceRoutes = require('./routes/attendance');
const activityRoutes = require('./routes/activity');
const lunchBreakRoutes = require('./routes/lunchBreak');
const screenshotRoutes = require('./routes/screenshots');
const reportRoutes = require('./routes/reports');
const userRoutes = require('./routes/users');
const settingsRoutes = require('./routes/settings');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('dev'));

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Attendance Management System API',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      attendance: '/api/attendance',
      activity: '/api/activity',
      lunchBreak: '/api/lunch-break',
      screenshots: '/api/screenshots',
      reports: '/api/reports',
      users: '/api/users',
      settings: '/api/settings',
    },
  });
});

app.get('/health', (req, res) => {
  res.json({ success: true, status: 'healthy', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/lunch-break', lunchBreakRoutes);
app.use('/api/screenshots', screenshotRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/users', userRoutes);
app.use('/api/settings', settingsRoutes);

app.use(notFound);
app.use(errorHandler);

cron.schedule('0 0 * * *', async () => {
  logger.info('Running daily aggregation job...');
  try {
    await runDailyAggregation();
  } catch (error) {
    logger.error('Daily aggregation job failed:', error);
  }
});

async function startServer() {
  try {
    connectRedis().catch(() => {
      logger.warn('⚠️  Starting server without Redis caching');
    });
    
    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 Server running on port ${PORT}`);
      logger.info(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`🔗 API URL: http://0.0.0.0:${PORT}`);
      logger.info('✅ Daily aggregation job scheduled for midnight');
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
