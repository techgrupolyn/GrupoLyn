export function ensureRemoteJid(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw;
  return `${raw}@s.whatsapp.net`;
}

export function resolveChatIdVariants(chatId: string): string[] {
  const base = String(chatId || '').trim();
  if (!base) return [];
  const normalized = base.replace(/@lid$/, '@s.whatsapp.net').replace(/@s\.whatsapp\.net$/, '@lid');
  const numeric = normalized.split('@')[0] || '';
  const variants = Array.from(new Set([base, normalized, `${numeric}@lid`, `${numeric}@s.whatsapp.net`].filter(Boolean)));
  return variants;
}

export function normalizeRemoteJid(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const [number] = raw.split('@');
  return number || raw;
}

export function toDate(value?: number | string | null): Date {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return new Date();
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return new Date(numeric * (String(Math.trunc(numeric)).length <= 10 ? 1000 : 1));
  }
  return new Date();
}
