// Normalización de teléfonos a E.164: la clave para vincular una llamada con un lead o cliente.
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

export const DEFAULT_REGION: CountryCode = 'ES';

export class InvalidPhone extends Error {}

/**
 * 638829213, 34638829213, 0034638829213 y +34 638 82 92 13 → +34638829213.
 * Netelip entrega números sin prefijo, con prefijo de país sin «+» y con «00».
 */
export function toE164(raw: string | null | undefined, region: CountryCode = DEFAULT_REGION): string {
  let candidate = String(raw || '').replace(/[^\d+]/g, '');
  if (!candidate) throw new InvalidPhone('teléfono vacío');
  if (candidate.startsWith('00')) candidate = '+' + candidate.slice(2);
  const attempts = candidate.startsWith('+') ? [candidate] : ['+' + candidate, candidate];
  for (const attempt of attempts) {
    const parsed = parsePhoneNumberFromString(attempt, attempt.startsWith('+') ? undefined : region);
    if (parsed?.isValid()) return parsed.number;
  }
  throw new InvalidPhone('teléfono no válido');
}

/** E.164 o null, sin lanzar: para teléfonos de texto libre del directorio (clientes, leads). */
export function tryE164(raw: string | null | undefined): string | null {
  try {
    return toE164(raw);
  } catch {
    return null;
  }
}

/** Para logs: solo las 3 últimas cifras. Las extensiones (≤ 4 cifras) no son dato personal. */
export function maskPhone(value: string | null | undefined): string {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length <= 4) return value || '-';
  return `***${digits.slice(-3)}`;
}
