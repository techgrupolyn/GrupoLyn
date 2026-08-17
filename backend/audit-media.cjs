const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect()
  .then(async () => {
    const r = await client.query(`SELECT tipo, COUNT(*) AS n, COUNT(*) FILTER (WHERE media IS NOT NULL) AS has_media, COUNT(*) FILTER (WHERE texto <> '' ) AS has_text FROM mensajes GROUP BY tipo ORDER BY n DESC`);
    console.log(r.rows);
    await client.end();
  })
  .catch((e) => { console.error(e); process.exit(1); });
