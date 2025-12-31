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
const autoCloseExcessiveBreaks = require('./jobs/autoCloseBreaks');
const autoCheckOutUsers = require('./jobs/autoCheckOut');
const autoCheckOutIdleUsers = require('./jobs/autoCheckOutIdle');
const createDailyAttendance = require('./jobs/createDailyAttendance');
const cleanupOldData = require('./jobs/cleanupOldData');

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

// Daily aggregation job (Midnight)
cron.schedule('0 0 * * *', async () => {
  logger.info('Running daily aggregation job...');
  try {
    await runDailyAggregation();
  } catch (error) {
    logger.error('Daily aggregation job failed:', error);
  }
});

// Auto-close excessive breaks job (Every 5 minutes)
cron.schedule('*/5 * * * *', async () => {
  try {
    await autoCloseExcessiveBreaks();
  } catch (error) {
    logger.error('Auto-close excessive breaks job failed:', error);
  }
});

// Auto-checkout excessive idle job (Every 5 minutes)
cron.schedule('*/5 * * * *', async () => {
  try {
    await autoCheckOutIdleUsers();
  } catch (error) {
    logger.error('Auto-checkout idle users job failed:', error);
  }
});

// Gap Detection Job (Every 1 minute)
// Checks for users who stopped sending heartbeats (e.g. Tracker closed/crashed)
// Transitions them to IDLE after 5 minutes of silence.
const activityService = require('./services/activityService');
cron.schedule('* * * * *', async () => {
  try {
    await activityService.checkForIdleUsers();
  } catch (error) {
    logger.error('Gap detection job failed:', error);
  }
});

// Auto-checkout job (Daily at 23:59) - use explicit timezone if provided
const serverTimeZone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
logger.info(`Scheduling auto-checkout job to run at 23:59 server timezone: ${serverTimeZone}`);
cron.schedule('59 23 * * *', async () => {
  try {
    await autoCheckOutUsers();
  } catch (error) {
    logger.error('Auto-checkout job failed:', error);
  }
}, {
  timezone: serverTimeZone,
});

// Cleanup old screenshots and related data (Daily at 02:00)
cron.schedule('0 2 * * *', async () => {
  logger.info('Running cleanupOldData job (screenshots retention)...');
  try {
    const result = await cleanupOldData();
    logger.info(`cleanupOldData result: ${JSON.stringify(result)}`);
  } catch (error) {
    logger.error('cleanupOldData job failed:', error);
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
      // Attempt to backfill any missed auto-checkouts that occurred while the server was down
      try {
        if (typeof autoCheckOutUsers?.backfillMissed === 'function') {
          autoCheckOutUsers.backfillMissed()
            .then(result => logger.info(`Backfill result: ${JSON.stringify(result)}`))
            .catch(err => logger.error('Backfill failed on startup:', err));
        }
      } catch (err) {
        logger.error('Error invoking backfill on startup:', err);
      }

      // Ensure today's attendance rows exist (create missing per-user rows)
      try {
        createDailyAttendance()
          .then(res => logger.info(`createDailyAttendance result: ${JSON.stringify(res)}`))
          .catch(err => logger.error('createDailyAttendance failed on startup:', err));
      } catch (err) {
        logger.error('Error invoking createDailyAttendance on startup:', err);
      }
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
