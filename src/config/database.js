const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Do NOT exit the process here. An error on an *idle* pooled client is a
// routine, recoverable event (DB restart, network blip, idle timeout) — pg
// discards the bad client and creates a new one on the next request. Calling
// process.exit() turned every such blip into a full API outage for all users.
pool.on('error', (err) => {
  console.error('Unexpected error on idle postgres client (pool will recover):', err.message);
});

module.exports = pool;
