import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export type GoogleDriveArtifactType = 'transcript' | 'notes' | 'recording' | 'audio' | 'document' | 'other';

export function parseGoogleDriveFolderId(value: string): string | null {
  const raw = String(value || '').trim();
  const match = raw.match(/(?:drive\.google\.com\/drive\/folders\/)?([A-Za-z0-9_-]{10,})/);
  return match?.[1] || null;
}

export function classifyGoogleDriveArtifact(mimeType: string, name: string): GoogleDriveArtifactType {
  const mime = String(mimeType || '').toLowerCase();
  const fileName = String(name || '').toLowerCase();
  if (mime.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/i.test(fileName)) return 'recording';
  if (mime.startsWith('audio/') || /\.(mp3|m4a|wav|ogg)$/i.test(fileName)) return 'audio';
  if (/transcri|\.vtt$|\.srt$|\.sbv$/i.test(fileName)) return 'transcript';
  if (/note|nota|resumen/i.test(fileName)) return 'notes';
  if (mime === 'application/vnd.google-apps.document' || mime.startsWith('text/') || /\.(txt|md|pdf|docx)$/i.test(fileName)) return 'document';
  return 'other';
}

function encryptionKey(value: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY debe tener 64 caracteres hexadecimales');
  return Buffer.from(value, 'hex');
}

export function encryptGoogleDriveSecret(value: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyHex), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptGoogleDriveSecret(value: string, keyHex: string): string {
  const [ivValue, tagValue, encryptedValue] = String(value || '').split('.');
  if (!ivValue || !tagValue || !encryptedValue) throw new Error('Token de Google Drive cifrado inválido');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(keyHex), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

export function canExtractGoogleDriveText(mimeType: string, name: string): boolean {
  const mime = String(mimeType || '').toLowerCase();
  const fileName = String(name || '').toLowerCase();
  return mime === 'application/vnd.google-apps.document' || mime.startsWith('text/') || /\.(txt|vtt|srt|sbv|md)$/i.test(fileName);
}
