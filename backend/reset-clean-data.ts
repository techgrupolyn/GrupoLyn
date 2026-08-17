import 'dotenv/config';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';

if (process.env.CONFIRM_CLEAN_RESET !== 'YES') {
  throw new Error('Operación destructiva bloqueada. Ejecuta con CONFIRM_CLEAN_RESET=YES para reiniciar la base de datos.');
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(currentDirectory, '..', 'schema.sql');
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/superagente';
const pool = new Pool({ connectionString });

try {
  const schema = await readFile(schemaPath, 'utf8');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(schema);
  console.log('Base de datos reiniciada con esquema multi-cuenta limpio.');
} finally {
  await pool.end();
}
