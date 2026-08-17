require('dotenv').config();
const p = require('pg');
const pool = new p.Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const owner = '584242403414@s.whatsapp.net';
  const ownerDigits = String(owner).replace(/\D/g, '');
  const chats = await pool.query(`SELECT id, nombre FROM chats WHERE id LIKE $1 OR nombre ILIKE $2 ORDER BY updated_at DESC`, [`%@${ownerDigits}%`, `%alejandro%`]);
  console.log('Chats found:', chats.rows.length);
  chats.rows.forEach(c => console.log(c.id, c.nombre));
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
