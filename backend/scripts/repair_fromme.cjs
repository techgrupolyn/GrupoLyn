require('dotenv').config();
const p = require('pg');
const pool = new p.Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const ownerJid = '584242403414@s.whatsapp.net';
  const ownerDigits = String(ownerJid).replace(/\D/g, '');
  console.log('Owner digits:', ownerDigits);

  const { rows } = await pool.query(`SELECT id, remitente_jid, chat_id FROM mensajes WHERE enviado_por_mi = TRUE AND remitente_jid IS NOT NULL AND remitente_jid != ''`);
  const toFix = [];
  for (const row of rows) {
    const digits = String(row.remitente_jid || '').replace(/\D/g, '');
    console.log(`Message ${row.id.substring(0, 10)}... remitente_jid=${row.remitente_jid} digits=${digits} match=${digits === ownerDigits || digits.includes(ownerDigits)}`);
    if (!digits) continue;
    if (digits !== ownerDigits && !digits.includes(ownerDigits)) {
      toFix.push(row.id);
    }
  }
  console.log('Total to fix:', toFix.length);
  if (toFix.length) {
    await pool.query(`UPDATE mensajes SET enviado_por_mi = FALSE WHERE id = ANY($1::text[])`, [toFix]);
    console.log('Fixed!');
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
