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
