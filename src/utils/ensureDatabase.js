const { Pool } = require('pg');
const logger = require('./logger');

/**
 * Ensure that the target database defined in the DATABASE_URL exists.
 * If it is missing, connect to the default `postgres` database using the
 * same credentials and create it automatically.
 *
 * @param {string} connectionString Full DATABASE_URL connection string
 */
async function ensureDatabaseExists(connectionString) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const databaseUrl = new URL(connectionString);
  const targetDbName = databaseUrl.pathname.replace('/', '');

  if (!targetDbName) {
    throw new Error('DATABASE_URL does not include a database name');
  }

  const adminUrl = new URL(connectionString);
  adminUrl.pathname = '/postgres';

  const adminPool = new Pool({ connectionString: adminUrl.toString() });

  let client;
  try {
    client = await adminPool.connect();
    const result = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [targetDbName]
    );

    if (result.rowCount === 0) {
      logger.info(`Database "${targetDbName}" not found. Creating...`);
      await client.query(`CREATE DATABASE "${targetDbName}"`);
      logger.info(`Database "${targetDbName}" created successfully.`);
    } else {
      logger.info(`Database "${targetDbName}" already exists.`);
    }
  } catch (error) {
    logger.error('Failed to verify/create database:', error);
    throw error;
  } finally {
    if (client) {
      client.release();
    }
    await adminPool.end();
  }
}

module.exports = ensureDatabaseExists;

