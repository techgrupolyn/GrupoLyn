export type ProtocolPrivacyContext = { clientNames?: string[] };

const personalPatterns: Array<[RegExp, string]> = [
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[EMAIL]'],
  [/\bES\d{2}(?:[\s-]*\d{4}){5}\b/giu, '[IBAN]'],
  [/\b\d{8}[A-Z]\b|\b[XYZ]\d{7}[A-Z]\b/giu, '[DNI]'],
  [/(?<!\w)(?:\+|00)\d{1,3}(?:[\s.-]?\d){7,14}(?!\w)|(?<!\w)[679](?:[\s.-]?\d){8}(?!\w)/gu, '[TELÉFONO]'],
  [/\b(?:calle|c\/|avenida|avda\.?|paseo|plaza|pl\.?|carretera|camino)\s+[\p{L}\d\s.,ºª/-]{3,70}(?=[;\n]|$)/giu, '[DIRECCIÓN]'],
];

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function maskProtocolQuestion(question: string, context: ProtocolPrivacyContext = {}): string {
  let masked = question;
  const names = [...new Set(context.clientNames || [])].filter(name => name.trim().length >= 4).sort((left, right) => right.length - left.length);
  for (const name of names) masked = masked.replace(new RegExp(`(?<![\\p{L}])${escapePattern(name)}(?![\\p{L}])`, 'giu'), '[NOMBRE]');
  for (const [pattern, marker] of personalPatterns) masked = masked.replace(pattern, marker);
  return masked;
}

export function containsUnmaskedPersonalData(text: string): boolean {
  return personalPatterns.some(([pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function canReadProtocolLog(role: unknown): boolean {
  const normalized = String(role || '').normalize('NFD').replace(/[\u0300-\u036f]/gu, '').trim().toLowerCase().replace(/[\s/-]+/gu, '_');
  return ['superadmin', 'employee:director', 'employee:director_general', 'employee:director_de_operaciones', 'employee:direccion_de_operaciones'].includes(normalized);
}

export function canReadProtocolReport(role: unknown): boolean {
  const normalized = String(role || '').normalize('NFD').replace(/[\u0300-\u036f]/gu, '').trim().toLowerCase().replace(/[\s/-]+/gu, '_');
  return canReadProtocolLog(role) || normalized === 'employee:gerente_tecnico';
}
