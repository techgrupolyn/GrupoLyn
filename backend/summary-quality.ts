export function entityKey(value: string): string {
  return value.toLocaleLowerCase().normalize('NFD').replace(/n\u0303/g, 'ñ').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();
}

export function workName(value: string): string {
  return value.trim().replace(/^(?:(?:obra|proyecto)\s+)+/iu, '').trim();
}

export function requestsWorkGrouping(prompt: string): boolean {
  return /(?:agrup\w*|organiz\w*|separ\w*)[^.\n]{0,45}\bpor\s+obra/iu.test(prompt);
}

export function measurements(text: string): string[] {
  return [...text.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(mm|cm|metros?|m|euros?|€)(?!\p{L})/giu)]
    .map((match) => `${match[1].replace(',', '.')}:${match[2].toLocaleLowerCase().replace(/^metros?$/, 'm').replace(/^euros?$/, '€')}`);
}

export function evidenceQuotes(evidence: unknown): string[] {
  if (!Array.isArray(evidence)) return [];
  return evidence.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    return typeof item.quote === 'string' ? [item.quote] : evidenceQuotes(item.evidence);
  });
}

export function reportText(text: string): string {
  return text
    .replace(/\[?\bG\d+-(?:F\d+|M\d+(?:-P\d+)?)\b\]?/g, '')
    .replace(/((?:contrase[ñn]a|password|pin|c[oó]digo\s+(?:de\s+)?(?:acceso|candado)|candado(?:\s+(?:con\s+)?c[oó]digo)?)\s*(?:es\s*|[:=]\s*)?)["']?[\w-]*\d[\w-]*["']?/giu, '$1[oculto]')
    .replace(/[ \t]{2,}/g, ' ').trim();
}
