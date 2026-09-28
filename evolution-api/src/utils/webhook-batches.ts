export function splitWebhookBatches(payload: Record<string, any>, maxBytes = 512 * 1024): Record<string, any>[] {
  const event = String(payload.event || '').replace(/[.-]/g, '_').toUpperCase();
  if (!/^(MESSAGES|CHATS|CONTACTS)_(SET|UPSERT|UPDATE|DELETE)$/.test(event) || !Array.isArray(payload.data)) {
    return [payload];
  }
  if (payload.data.length < 2) return [payload];

  const envelopeBytes = Buffer.byteLength(JSON.stringify({ ...payload, data: [] }), 'utf8');
  const batches: Record<string, any>[] = [];
  let items: unknown[] = [];
  let size = envelopeBytes;
  for (const item of payload.data) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item) ?? 'null', 'utf8');
    const separatorBytes = items.length ? 1 : 0;
    if (items.length && size + separatorBytes + itemBytes > maxBytes) {
      batches.push({ ...payload, data: items });
      items = [];
      size = envelopeBytes;
    }
    size += (items.length ? 1 : 0) + itemBytes;
    items.push(item);
  }
  if (items.length) batches.push({ ...payload, data: items });
  return batches;
}
