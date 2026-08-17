const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect()
  .then(async () => {
    const r1 = await client.query('SELECT COUNT(*) AS n FROM resumenes_chat');
    const r2 = await client.query('SELECT COUNT(*) AS n FROM respuestas_chat');
    console.log('resumenes_chat count:', r1.rows[0].n);
    console.log('respuestas_chat count:', r2.rows[0].n);
    const latestSummary = await client.query('SELECT id,chat_id,especialista_id,left(resumen,80) AS resumen,created_at FROM resumenes_chat ORDER BY id DESC LIMIT 1');
    console.log('latest summary:', latestSummary.rows[0] || null);
    await client.end();
  })
  .catch((e) => { console.error(e); process.exit(1); });
