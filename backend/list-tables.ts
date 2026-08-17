import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgresql://postgres:postgres@localhost:5432/superagente',
});

async function main() {
  const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
  console.log(rows.map(r => r.table_name).join(', '));
  await pool.end();
}

main();
