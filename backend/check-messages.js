const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: 'postgresql://postgres:postgres@localhost:5432/superagente'
  });

  try {
    await client.connect();
    
    // Check messages for this chat
    const chatId = '173594189521071@s.whatsapp.net';
    const result = await client.query(
      "SELECT id, timestamp, texto, enviado_por_mi, source FROM mensajes WHERE chat_id = $1 ORDER BY timestamp DESC LIMIT 20",
      [chatId]
    );
    
    console.log(`\n=== Últimos 20 mensajes de ${chatId} ===`);
    result.rows.forEach(row => {
      const text = (row.texto || '').slice(0, 60);
      console.log(`${row.timestamp} | ${row.enviado_por_mi ? 'YO' : 'CONTACTO'} | ${text}`);
    });
    
    // Check if there are messages from today at all
    const today = new Date().toISOString().split('T')[0];
    const todayResult = await client.query(
      "SELECT COUNT(*) as count FROM mensajes WHERE chat_id = $1 AND timestamp::date = $2",
      [chatId, today]
    );
    console.log(`\nMensajes de hoy (${today}): ${todayResult.rows[0].count}`);
    
    // Check all messages from today in the entire database
    const allTodayResult = await client.query(
      "SELECT COUNT(*) as count FROM mensajes WHERE timestamp::date = $1",
      [today]
    );
    console.log(`Mensajes de hoy en toda la DB: ${allTodayResult.rows[0].count}`);
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
}

main();
