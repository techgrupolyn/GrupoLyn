import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { evolutionHistoryPages } from '../evolution-history.ts';

describe('historial de Evolution para informes', () => {
  it.each(['evolution.production.env.example', 'instance/evolution.env.example'])('la plantilla %s conserva mensajes nuevos e históricos', async (path) => {
    const source = await readFile(new URL(`../../deploy/env/${path}`, import.meta.url), 'utf8');
    expect(source).toMatch(/^DATABASE_SAVE_DATA_NEW_MESSAGE=true\r?$/m);
    expect(source).toMatch(/^DATABASE_SAVE_DATA_HISTORIC=true\r?$/m);
  });

  it('recorre todas las páginas con offset y filtra ambos JID sin límite total', async () => {
    const remoteJid = '120363000000000@g.us';
    const fetcher = vi.fn(async (body: Record<string, unknown>) => ({ messages: {
      pages: 201, currentPage: Number(body.page), records: Array.from({ length: 100 }, (_, index) => ({
        key: { id: `${body.page}-${index}`, remoteJid },
      })),
    } }));
    let total = 0;
    for await (const messages of evolutionHistoryPages(fetcher, remoteJid)) total += messages.length;
    expect(total).toBe(20100);
    expect(fetcher).toHaveBeenCalledTimes(201);
    expect(fetcher).toHaveBeenLastCalledWith({ page: 201, offset: 100, where: { key: { remoteJid, remoteJidAlt: remoteJid } } });
  });

  it('deduplica páginas solapadas y permite finalizar antes de recorrer el resto del historial', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ messages: { pages: 3, records: [{ key: { id: 'first' } }] } })
      .mockResolvedValueOnce({ messages: { pages: 3, records: [{ key: { id: 'first' } }, { key: { id: 'second' } }] } });
    const ids: string[] = [];
    for await (const messages of evolutionHistoryPages(fetcher)) {
      ids.push(...messages.map((message) => message.key!.id!));
      if (ids.length === 2) break;
    }
    expect(ids).toEqual(['first', 'second']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    {}, { messages: { pages: 2, records: [] } },
    { messages: { pages: 1, currentPage: 2, records: [] } },
    { messages: { pages: 1, records: [{}] } },
    { messages: { pages: 1, records: [{ key: { id: 'other', remoteJid: 'other@g.us' } }] } },
  ])('rechaza respuestas inválidas o de otro grupo: %j', async (response) => {
    const fetcher = vi.fn().mockResolvedValue(response);
    await expect(async () => {
      for await (const messages of evolutionHistoryPages(fetcher, 'target@g.us')) void messages;
    }).rejects.toThrow();
  });

  it('un historial vacío válido no implica que los pendientes estén analizados', async () => {
    const pages = [];
    for await (const messages of evolutionHistoryPages(async () => ({ messages: { pages: 0, records: [] } }))) pages.push(messages);
    expect(pages).toEqual([[]]);
  });
});
