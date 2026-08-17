require('dotenv').config();
const p = require('pg');
const pool = new p.Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const chats = await pool.query(`SELECT id, nombre FROM chats ORDER BY updated_at DESC LIMIT 10`);
  for (const chat of chats.rows) {
    const msgs = await pool.query(`SELECT id, enviado_por_mi, texto, timestamp FROM mensajes WHERE chat_id = $1 ORDER BY timestamp ASC LIMIT 5`, [chat.id]);
    console.log(`\nChat: ${chat.id} (${chat.nombre})`);
    console.log(`  Mensajes: ${msgs.rows.length}`);
    for (const m of msgs.rows) {
      console.log(`  - ${m.id.substring(0, 10)}... fromMe=${m.enviado_por_mi} texto=${(m.texto || '').substring(0, 30)}`);
    }
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
