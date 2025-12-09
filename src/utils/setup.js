require('dotenv').config();
const logger = require('./logger');
const ensureDatabaseExists = require('./ensureDatabase');
const runMigration = require('./migrate');
const seedData = require('./seed');
const { Pool } = require('pg');

async function setupDatabase() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    logger.info('🚀 Starting database setup...');

    await ensureDatabaseExists(process.env.DATABASE_URL);
    logger.info('✅ Database verified/created');

    // Check if tables already exist
    const client = await pool.connect();
    let tablesExist = false;

    try {
      const result = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'users'
        );
      `);
      tablesExist = result.rows[0].exists;
    } finally {
      client.release();
    }

    if (tablesExist) {
      logger.info('ℹ️  Tables already exist, skipping migration and seeding');
      logger.info('✅ Database is ready (existing data preserved)');
    } else {
      logger.info('📋 Tables do not exist, running migration...');
      await runMigration();
      logger.info('✅ Migrations complete');

      logger.info('🌱 Seeding initial data...');
      await seedData();
      logger.info('✅ Seeding complete');
    }

    logger.info('🎉 Database setup finished successfully!');
  } catch (error) {
    logger.error('❌ Database setup failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  setupDatabase();
}

module.exports = setupDatabase;

