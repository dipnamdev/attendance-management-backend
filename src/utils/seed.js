const bcrypt = require('bcrypt');
const pool = require('../config/database');
const logger = require('../utils/logger');
const ensureDatabaseExists = require('./ensureDatabase');

async function seedData() {
  await ensureDatabaseExists(process.env.DATABASE_URL);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    logger.info('Starting data seeding...');

    const adminPassword = await bcrypt.hash('admin123', 10);
    const employeePassword = await bcrypt.hash('employee123', 10);

    const adminResult = await client.query(
      `INSERT INTO users (email, password_hash, name, employee_id, role) 
       VALUES ($1, $2, $3, $4, $5) 
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      ['admin@company.com', adminPassword, 'Admin User', 'EMP001', 'admin']
    );

    if (adminResult.rows.length > 0) {
      logger.info('✅ Admin user created: admin@company.com / admin123');
    }

    const employees = [
      { email: '0112@gmail.com', name: 'CwS User', employee_id: 'EMP002' },
    ];

    for (const employee of employees) {
      const result = await client.query(
        `INSERT INTO users (email, password_hash, name, employee_id, role) 
         VALUES ($1, $2, $3, $4, $5) 
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [employee.email, employeePassword, employee.name, employee.employee_id, 'employee']
      );

      if (result.rows.length > 0) {
        logger.info(`✅ Employee created: ${employee.email} / employee123`);
      }
    }

    const defaultSettings = [
      {
        key: 'screenshot_interval',
        value: { minutes: 10 },
        description: 'Interval for capturing screenshots in minutes',
      },
      {
        key: 'idle_threshold',
        value: { seconds: 300 },
        description: 'Idle time threshold in seconds',
      },
      {
        key: 'working_hours',
        value: { start: '09:00', end: '18:00' },
        description: 'Standard working hours',
      },
      {
        key: 'max_break_duration',
        value: { minutes: 60 },
        description: 'Maximum lunch break duration in minutes',
      },
    ];

    for (const setting of defaultSettings) {
      await client.query(
        `INSERT INTO system_settings (setting_key, setting_value, description) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (setting_key) DO NOTHING`,
        [setting.key, JSON.stringify(setting.value), setting.description]
      );
    }

    logger.info('✅ Default system settings created');

    await client.query('COMMIT');

    logger.info('✅ Data seeding completed successfully!');
    logger.info('\n📝 Login Credentials:');
    logger.info('   Admin: admin@company.com / admin123');
    logger.info('   Employee: john.doe@company.com / employee123');
    logger.info('   Employee: jane.smith@company.com / employee123');
    logger.info('   Employee: mike.johnson@company.com / employee123\n');

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('❌ Seeding failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  seedData();
}

module.exports = seedData;
