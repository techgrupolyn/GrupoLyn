const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect()
  .then(async () => {
    const r = await client.query(`SELECT chat_id, COUNT(*) AS n, COUNT(*) FILTER (WHERE media->>'jpegThumbnail' IS NOT NULL) AS thumbs FROM mensajes WHERE tipo='image' GROUP BY chat_id ORDER BY n DESC LIMIT 10`);
    console.log(r.rows);
    await client.end();
  })
  .catch((e) => { console.error(e); process.exit(1); });
