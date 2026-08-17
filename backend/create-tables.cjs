const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect()
  .then(async () => {
    await client.query(`CREATE TABLE IF NOT EXISTS resumenes_chat (
      id SERIAL PRIMARY KEY,
      chat_id VARCHAR(255) NOT NULL,
      especialista_id VARCHAR(120) NOT NULL DEFAULT 'general',
      resumen TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_resumenes_chat_chat_id ON resumenes_chat(chat_id)`);
    await client.query(`CREATE TABLE IF NOT EXISTS respuestas_chat (
      id SERIAL PRIMARY KEY,
      chat_id VARCHAR(255) NOT NULL,
      especialista_id VARCHAR(120) NOT NULL DEFAULT 'general',
      respuesta TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_respuestas_chat_chat_id ON respuestas_chat(chat_id)`);
    console.log('OK');
    await client.end();
  })
  .catch((e) => { console.error(e); process.exit(1); });
