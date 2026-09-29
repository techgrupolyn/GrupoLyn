export function unwrapWhatsAppContent(value: unknown): Record<string, unknown> {
  let content = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const wrappers = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'associatedChildMessage'];
  for (let depth = 0; depth < 10; depth += 1) {
    const wrapper = wrappers.map((name) => content[name]).find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).message);
    const nested = wrapper && (wrapper as Record<string, unknown>).message;
    if (!nested || typeof nested !== 'object') break;
    content = nested as Record<string, unknown>;
  }
  return content;
}

export function nonTextWhatsAppKind(value: unknown, messageType = ''): string | null {
  if (typeof value === 'string' && value.trim()) return null;
  const content = unwrapWhatsAppContent(value);
  if (typeof content.conversation === 'string' || content.extendedTextMessage) return null;
  const kinds: Record<string, string> = {
    imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', ptvMessage: 'video',
    documentMessage: 'document', stickerMessage: 'sticker', lottieStickerMessage: 'sticker', albumMessage: 'album',
    contactMessage: 'contact', contactsArrayMessage: 'contact',
    reactionMessage: 'reaction', groupStatusMentionMessage: 'status_mention',
  };
  for (const [field, kind] of Object.entries(kinds)) {
    if (content[field] && typeof content[field] === 'object') return kind;
  }
  return Object.hasOwn(kinds, messageType) ? kinds[messageType] : null;
}
