require('dotenv').config();
const p = require('pg');
const pool = new p.Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const res = await pool.query(`SELECT id, raw FROM mensajes WHERE chat_id = '173594189521071@lid' AND enviado_por_mi = TRUE LIMIT 1`);
  const row = res.rows[0];
  if (!row) {
    console.log('No message found');
    return;
  }
  console.log('ID:', row.id);
  console.log('RAW:', JSON.stringify(row.raw, null, 2).substring(0, 2000));
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
