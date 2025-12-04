require('dotenv').config();
const logger = require('./logger');
const ensureDatabaseExists = require('./ensureDatabase');
const runMigration = require('./migrate');
const seedData = require('./seed');

async function setupDatabase() {
  try {
    logger.info('🚀 Starting database setup...');

    await ensureDatabaseExists(process.env.DATABASE_URL);
    logger.info('✅ Database verified/created');

    await runMigration();
    logger.info('✅ Migrations complete');

    await seedData();
    logger.info('✅ Seeding complete');

    logger.info('🎉 Database setup finished successfully!');
  } catch (error) {
    logger.error('❌ Database setup failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  setupDatabase();
}

module.exports = setupDatabase;

