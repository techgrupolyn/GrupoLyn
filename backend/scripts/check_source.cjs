require('dotenv').config();
const p = require('pg');
const pool = new p.Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const chatId = '173594189521071@lid';
  
  // Check messages by source
  const sourceCount = await pool.query(`SELECT source, COUNT(*) as total, SUM(CASE WHEN enviado_por_mi = TRUE THEN 1 ELSE 0 END) as from_me FROM mensajes WHERE chat_id = $1 GROUP BY source`, [chatId]);
  console.log('Messages by source:', JSON.stringify(sourceCount.rows, null, 2));
  
  // Check total messages
  const total = await pool.query(`SELECT COUNT(*) as total FROM mensajes WHERE chat_id = $1`, [chatId]);
  console.log('Total messages:', total.rows[0].total);
  
  // Check first and last message
  const first = await pool.query(`SELECT id, enviado_por_mi, texto, timestamp, source FROM mensajes WHERE chat_id = $1 ORDER BY timestamp ASC LIMIT 1`, [chatId]);
  const last = await pool.query(`SELECT id, enviado_por_mi, texto, timestamp, source FROM mensajes WHERE chat_id = $1 ORDER BY timestamp DESC LIMIT 1`, [chatId]);
  console.log('First:', JSON.stringify(first.rows[0], null, 2));
  console.log('Last:', JSON.stringify(last.rows[0], null, 2));
  
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
