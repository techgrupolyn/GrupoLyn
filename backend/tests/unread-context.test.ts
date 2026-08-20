import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { getUnreadMessageContext, pool } from '../server.ts';

const account = {
  id: 'default',
  nombre: 'Cuenta principal',
  evolutionInstanceName: 'lyn-test',
  activo: true,
};
const createdChatIds: string[] = [];

afterEach(async () => {
  await Promise.all(createdChatIds.splice(0).map((chatId) => pool.query('DELETE FROM chats WHERE id = $1', [chatId])));
});

describe('getUnreadMessageContext', () => {
  it('usa el contador de WhatsApp aunque Evolution haya marcado los mensajes como leídos', async () => {
    const rawChatId = `120363${randomUUID().replace(/-/g, '').slice(0, 18)}@g.us`;
    const chatId = `default::${rawChatId}`;
    createdChatIds.push(chatId);

    await pool.query(
      `INSERT INTO chats (id, account_id, nombre, unread_count, whatsapp_unread_count, reviewed_unread_baseline)
       VALUES ($1, $2, 'Grupo de prueba', 2, 2, 0)`,
      [chatId, account.id],
    );
    await pool.query(
      `INSERT INTO mensajes (id, chat_id, account_id, remitente, texto, timestamp, enviado_por_mi, estado)
       VALUES
         ($1, $4, $5, 'Ana', 'Mensaje antiguo', NOW() - INTERVAL '3 minutes', FALSE, 'leido'),
         ($2, $4, $5, 'Bea', 'Primer mensaje pendiente', NOW() - INTERVAL '2 minutes', FALSE, 'entregado'),
         ($3, $4, $5, 'Carlos', 'Último mensaje pendiente', NOW() - INTERVAL '1 minute', FALSE, 'leido')`,
      [`context-${randomUUID()}`, `context-${randomUUID()}`, `context-${randomUUID()}`, chatId, account.id],
    );

    const context = await getUnreadMessageContext(rawChatId, account);

    expect(context.pendingCount).toBe(2);
    expect(context.rows).toHaveLength(2);
    expect(context.rows.map((message) => message.texto)).toEqual([
      'Último mensaje pendiente',
      'Primer mensaje pendiente',
    ]);
  });
});