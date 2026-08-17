import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgresql://postgres:postgres@localhost:5432/superagente',
});

async function main() {
  const { rows: cols } = await pool.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'mensajes'
    ORDER BY ordinal_position
  `);
  console.log('COLUMNAS mensajes:');
  for (const c of cols) {
    console.log(`- ${c.column_name} (${c.data_type}) nullable=${c.is_nullable}`);
  }

  const { rows: msgs } = await pool.query('SELECT id, remitente, enviado_por_mi, tipo, texto, timestamp FROM mensajes ORDER BY timestamp DESC LIMIT 5');
  console.log('\nMENSAJES:');
  for (const m of msgs) {
    console.log(JSON.stringify(m));
  }

  await pool.end();
}

main();
