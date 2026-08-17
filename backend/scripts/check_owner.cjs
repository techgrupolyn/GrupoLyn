require('dotenv').config();
const p = require('pg');
const pool = new p.Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const owner = '584242403414@s.whatsapp.net';
  const { rows } = await pool.query(`SELECT id, nombre, updated_at FROM chats WHERE id = $1 OR id = $2 OR nombre ILIKE $3 ORDER BY updated_at DESC`, [owner, owner.replace('@s.whatsapp.net', '@lid'), '%alejandro%']);
  console.log('Owner chats:', rows);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
