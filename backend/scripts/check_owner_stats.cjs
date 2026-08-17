require('dotenv').config();
const p = require('pg');
const pool = new p.Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const owner = '584242403414@s.whatsapp.net';
  const ownerLid = '584242403414@lid';
  const ownerDigits = '584242403414';

  const chatRows = await pool.query(`SELECT id, nombre FROM chats WHERE id = $1 OR id = $2 OR id LIKE $3`, [owner, ownerLid, `%${ownerDigits}%`]);
  console.log('Chat rows:', chatRows.rows);

  const msgRows = await pool.query(`SELECT COUNT(*) as total, SUM(CASE WHEN enviado_por_mi = TRUE THEN 1 ELSE 0 END) as from_me FROM mensajes WHERE remitente_jid = $1 OR remitente_jid = $2 OR remitente_jid LIKE $3`, [owner, ownerLid, `%${ownerDigits}%`]);
  console.log('Message stats:', msgRows.rows[0]);

  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
