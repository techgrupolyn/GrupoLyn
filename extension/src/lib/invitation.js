export function parseActivationCode(value) {
  const match = String(value || '').trim().match(/^LYN1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{24,})$/);
  if (!match) return null;
  try {
    const padded = match[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(match[1].length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const baseUrl = new URL(new TextDecoder().decode(bytes));
    const isLocal = baseUrl.hostname === 'localhost' || baseUrl.hostname === '127.0.0.1';
    if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && isLocal)) return null;
    return { backendUrl: baseUrl.origin, code: String(value || '').trim() };
  } catch {
    return null;
  }
}