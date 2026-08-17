const pg = require('pg');
const pool = new pg.Pool({ connectionString: 'postgresql://postgres:postgres@localhost:5432/superagente' });

async function main() {
  const { rows } = await pool.query(
    `SELECT id, chat_id, remitente, enviado_por_mi, tipo, texto, timestamp FROM mensajes WHERE remitente ILIKE '%Camii%' ORDER BY timestamp DESC LIMIT 20`
  );
  console.log(JSON.stringify(rows, null, 2));
  await pool.end();
}

main();
