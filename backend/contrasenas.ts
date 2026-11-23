// Hash de contraseñas de los usuarios locales del Dashboard (tabla usuarios): scrypt con sal aleatoria, «sal:resumen» en hex.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(value: string): string {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(value, salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

export function verifyPassword(value: string, storedHash: string | null | undefined): boolean {
  const [salt, digest] = String(storedHash || '').split(':');
  if (!salt || !digest) return false;
  const candidate = scryptSync(value, salt, 64).toString('hex');
  const expected = Buffer.from(digest, 'hex');
  const received = Buffer.from(candidate, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
