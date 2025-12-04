// import { Pool, neonConfig } from '@neondatabase/serverless';
// import { drizzle } from 'drizzle-orm/neon-serverless';
// import ws from "ws";
// import * as schema from "@shared/schema";

// neonConfig.webSocketConstructor = ws;

// if (!process.env.DATABASE_URL) {
//   throw new Error(
//     "DATABASE_URL must be set. Did you forget to provision a database?",
//   );
// }

// export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// export const db = drizzle({ client: pool, schema });
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set");
}

const targetDbName = databaseUrl.split("/").pop(); // attendance_db

// STEP 1: Connect to the default postgres database
const adminPool = new Pool({
  connectionString: databaseUrl.replace(targetDbName, "postgres"),
});

// STEP 2: Check if database exists and create if missing
async function ensureDatabaseExists() {
  const client = await adminPool.connect();
  try {
    const result = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [targetDbName]
    );

    if (result.rowCount === 0) {
      console.log(`Database "${targetDbName}" does not exist. Creating...`);
      await client.query(`CREATE DATABASE "${targetDbName}"`);
      console.log(`Database "${targetDbName}" created.`);
    } else {
      console.log(`Database "${targetDbName}" already exists.`);
    }
  } finally {
    client.release();
  }
}

await ensureDatabaseExists();

// STEP 3: Now connect normally to the target database
export const pool = new Pool({ connectionString: databaseUrl });
export const db = drizzle(pool, { schema });

console.log("Database ready.");

