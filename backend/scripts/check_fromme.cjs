require('dotenv').config();
const p = require('pg');
const pool = new p.Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const res = await pool.query(`SELECT id, chat_id, remitente_jid, enviado_por_mi FROM mensajes WHERE enviado_por_mi = TRUE AND remitente_jid IS NOT NULL AND remitente_jid != '' ORDER BY timestamp DESC LIMIT 30`);
  console.log(JSON.stringify(res.rows, null, 2));
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
