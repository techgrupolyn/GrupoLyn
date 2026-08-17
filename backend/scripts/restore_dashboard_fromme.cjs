require('dotenv').config();
const p = require('pg');
const pool = new p.Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const ownerDigits = String((process.env.INSTANCE_OWNER_NUMBER || '584242403414')).replace(/\D/g, '');

  const result = await pool.query(`
    UPDATE mensajes
    SET enviado_por_mi = TRUE
    WHERE source = 'dashboard'
      AND enviado_por_mi = FALSE
    RETURNING id, chat_id, texto
  `);

  console.log('Restaurados', result.rows.length, 'mensajes del dashboard');
  result.rows.slice(0, 10).forEach(r => console.log(' -', r.id.substring(0, 10), r.chat_id, (r.texto || '').substring(0, 30)));

  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
