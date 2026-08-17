const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:postgres@localhost:5432/superagente' });

Promise.all([
  pool.query('SELECT count(*) AS grupos FROM grupos'),
  pool.query('SELECT count(*) AS mensajes FROM mensajes'),
  pool.query('SELECT id, nombre, source, updated_at FROM grupos ORDER BY updated_at DESC LIMIT 5'),
  pool.query("SELECT id, chat_id, source FROM mensajes WHERE source = 'extension' ORDER BY timestamp DESC LIMIT 5"),
]).then(([g, m, rows, em]) => {
  console.log('grupos count:', g.rows[0]);
  console.log('mensajes count:', m.rows[0]);
  console.log('grupos sample:', JSON.stringify(rows.rows, null, 2));
  console.log('extension messages:', JSON.stringify(em.rows, null, 2));
  pool.end();
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
