const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3003,
  path: '/api/chats',
  method: 'GET',
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      console.log('Total chats:', json.length);
      const duplicates = json.filter((chat, i, arr) => arr.findIndex((c) => c.id === chat.id) !== i);
      console.log('Duplicate IDs:', duplicates.map((c) => c.id));
      json.slice(0, 5).forEach((chat) => {
        console.log(`- ${chat.id} (${chat.nombre})`);
      });
    } catch (e) {
      console.log('Raw:', data.substring(0, 500));
    }
  });
});

req.on('error', (e) => { console.error(e.message); process.exit(1); });
req.end();
