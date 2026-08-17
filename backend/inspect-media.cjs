require('dotenv').config({ path: '.env' });
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect().then(async () => {
  try {
    const res = await client.query(`SELECT id, chat_id, tipo, media->>'mimetype' AS mimetype, length(media->>'jpegThumbnail') AS thumb_len FROM mensajes WHERE chat_id = '584123862271-1470006008@g.us' AND tipo IN ('image','sticker','video') ORDER BY timestamp DESC LIMIT 5`);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error('QUERY_ERROR', err.message);
  } finally {
    client.end();
  }
});
