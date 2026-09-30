import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { Server } from 'engine.io';
import { Address4, Address6 } from 'ip-address';
import { describe, expect, it } from 'vitest';

describe('Dependencias de seguridad del backend', () => {
  it.each(['&EIO=3', ''])('rechaza una actualización WebSocket con protocolo incompatible: %s', async (revision) => {
    const server = createServer();
    const engine = new Server();
    engine.attach(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Puerto local no disponible');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const handshake = await fetch(`${base}/engine.io/?EIO=4&transport=polling`);
      const { sid } = JSON.parse((await handshake.text()).slice(1));
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const upgrade = request(`${base}/engine.io/?transport=websocket&sid=${encodeURIComponent(sid)}${revision}`, {
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          },
        });
        upgrade.on('response', (response) => {
          response.resume();
          resolve(response.statusCode);
        });
        upgrade.on('upgrade', (_response, socket) => {
          socket.destroy();
          reject(new Error('Se aceptó un protocolo incompatible'));
        });
        upgrade.on('error', reject);
        upgrade.setTimeout(3000, () => upgrade.destroy(new Error('Tiempo de espera agotado')));
        upgrade.end();
      });
      expect(status).toBe(400);
      const nextHandshake = await fetch(`${base}/engine.io/?EIO=4&transport=polling`);
      expect(nextHandshake.status).toBe(200);
      expect(await nextHandshake.text()).toMatch(/^0\{/);
    } finally {
      engine.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('reconoce direcciones link-local fuera del prefijo fe80::/64', () => {
    expect(new Address6('fe90::1').isLinkLocal()).toBe(true);
  });

  it('no mezcla subredes IPv4 e IPv6', () => {
    expect(new Address4('127.0.0.1').isInSubnet(new Address6('::/0'))).toBe(false);
    expect(new Address6('::1').isHostInSubnet(new Address4('0.0.0.0/0'))).toBe(false);
  });
});
