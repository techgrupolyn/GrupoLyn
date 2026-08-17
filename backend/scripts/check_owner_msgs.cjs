require('dotenv').config();
const p = require('pg');
const pool = new p.Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const ids = ['239521803317280@lid', '237172389109806@lid'];
  for (const chatId of ids) {
    const msgs = await pool.query(`SELECT COUNT(*) as total, SUM(CASE WHEN enviado_por_mi = TRUE THEN 1 ELSE 0 END) as from_me FROM mensajes WHERE chat_id = $1`, [chatId]);
    console.log(`${chatId}: total=${msgs.rows[0].total}, fromMe=${msgs.rows[0].from_me}`);
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
