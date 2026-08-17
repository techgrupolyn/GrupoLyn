const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect().then(async () => {
  const r = await client.query("SELECT id, chat_id, tipo, media FROM mensajes WHERE chat_id = '584123862271-1470006008@g.us'");
  console.log('rows:', r.rows.length);
  r.rows.forEach((row, i) => {
    try {
      const m = typeof row.media === 'string' ? JSON.parse(row.media) : row.media;
      console.log(i, 'OK', row.tipo, row.id.substring(0, 10), JSON.stringify(m).substring(0, 80));
    } catch (e) {
      console.log(i, 'BAD', row.tipo, row.id.substring(0, 10), e.message.substring(0, 80));
    }
  });
  await client.end();
}).catch(e => {
  console.error('ERR:', e.message);
  process.exit(1);
});
