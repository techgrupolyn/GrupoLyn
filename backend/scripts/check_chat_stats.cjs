require('dotenv').config();
const p = require('pg');
const pool = new p.Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const chats = await pool.query(`SELECT id, nombre FROM chats ORDER BY updated_at DESC LIMIT 20`);
  for (const chat of chats.rows) {
    const total = await pool.query(`SELECT COUNT(*) as total, SUM(CASE WHEN enviado_por_mi = TRUE THEN 1 ELSE 0 END) as from_me FROM mensajes WHERE chat_id = $1`, [chat.id]);
    const { total: t, from_me: fm } = total.rows[0];
    console.log(`${chat.id} (${chat.nombre}): total=${t}, fromMe=${fm}`);
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
