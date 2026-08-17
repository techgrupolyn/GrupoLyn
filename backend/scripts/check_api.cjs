const http = require('http');

const chatId = process.argv[2] || '173594189521071@lid';

const options = {
  hostname: 'localhost',
  port: 3003,
  path: `/api/chats/${encodeURIComponent(chatId)}/mensajes`,
  method: 'GET',
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      console.log('Total messages:', json.length);
      const fromMe = json.filter((m) => m.enviado_por_mi).length;
      const notFromMe = json.filter((m) => !m.enviado_por_mi).length;
      console.log('FromMe:', fromMe, 'NotFromMe:', notFromMe);
      console.log('First 3:', json.slice(0, 3).map((m) => ({ id: m.id.substring(0, 10), fromMe: m.enviado_por_mi, texto: (m.texto || '').substring(0, 30) })));
    } catch (e) {
      console.log('Raw:', data.substring(0, 500));
    }
  });
});

req.on('error', (e) => { console.error(e.message); process.exit(1); });
req.end();
