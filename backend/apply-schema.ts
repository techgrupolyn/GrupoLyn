import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/superagente',
});

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);

async function runMigrations() {
  const client = await pool.connect();
  try {
    const sqlPath = path.join(currentDirectory, '..', 'schema.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('Applying schema v2...');
    await client.query(sql);
    console.log('Schema applied successfully');

    const { rows } = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    console.log('Tables:', rows.map(r => r.table_name).join(', '));
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
