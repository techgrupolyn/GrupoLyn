import type { MessageItem } from './types/index.ts';

type HistoryPage = { records?: MessageItem[]; pages?: number; currentPage?: number };
type HistoryResponse = HistoryPage & { messages?: HistoryPage };

export async function* evolutionHistoryPages(
  fetchPage: (body: Record<string, unknown>) => Promise<HistoryResponse>,
  remoteJid?: string,
): AsyncGenerator<MessageItem[]> {
  let page = 1;
  const seen = new Set<string>();
  while (true) {
    const payload = await fetchPage({ page, offset: 100,
      ...(remoteJid ? { where: { key: { remoteJid, remoteJidAlt: remoteJid } } } : {}),
    });
    const result = payload?.messages || payload;
    const pages = Number(result?.pages);
    if (!Array.isArray(result?.records) || !Number.isSafeInteger(pages) || pages < 0
      || (result.currentPage !== undefined && Number(result.currentPage) !== page)) {
      throw new Error('Evolution devolvió una paginación de historial inválida');
    }
    const fresh: MessageItem[] = [];
    for (const message of result.records) {
      const id = String(message.key?.id || message.id || '');
      if (!id) throw new Error('Evolution devolvió un mensaje sin identificador');
      if (remoteJid && message.key?.remoteJid !== remoteJid && message.key?.remoteJidAlt !== remoteJid) {
        throw new Error('Evolution devolvió historial de otro chat');
      }
      if (!seen.has(id)) { seen.add(id); fresh.push(message); }
    }
    if (!fresh.length && page < pages) throw new Error('La paginación del historial no avanza');
    yield fresh;
    if (page >= pages) return;
    page += 1;
  }
}
