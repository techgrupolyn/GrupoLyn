require('dotenv').config();
const p = require('pg');
const pool = new p.Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const owner = '584242403414@s.whatsapp.net';
  const ownerLid = '584242403414@lid';
  const chats = await pool.query(`SELECT id, nombre, updated_at FROM chats WHERE id = $1 OR id = $2 ORDER BY updated_at DESC`, [owner, ownerLid]);
  console.log('Owner chats:', chats.rows);
  for (const chat of chats.rows) {
    const msgs = await pool.query(`SELECT COUNT(*) as total, SUM(CASE WHEN enviado_por_mi = TRUE THEN 1 ELSE 0 END) as from_me FROM mensajes WHERE chat_id = $1`, [chat.id]);
    console.log(`${chat.id}: total=${msgs.rows[0].total}, fromMe=${msgs.rows[0].from_me}`);
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
