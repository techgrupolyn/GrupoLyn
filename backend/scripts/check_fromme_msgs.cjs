require('dotenv').config();
const p = require('pg');
const pool = new p.Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const ownerDigits = '584242403414';
  const { rows } = await pool.query(`SELECT id, chat_id, enviado_por_mi, texto, timestamp FROM mensajes WHERE enviado_por_mi = TRUE ORDER BY timestamp DESC LIMIT 20`);
  console.log('Total fromMe messages:', rows.length);
  rows.forEach(m => console.log(m.id.substring(0, 10), m.chat_id, m.enviado_por_mi, (m.texto || '').substring(0, 30)));
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
