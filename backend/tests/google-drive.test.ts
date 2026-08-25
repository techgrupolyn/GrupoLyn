import { describe, expect, it } from 'vitest';
import { canExtractGoogleDriveText, classifyGoogleDriveArtifact, decryptGoogleDriveSecret, encryptGoogleDriveSecret, parseGoogleDriveFolderId } from '../google-drive.ts';

describe('Google Drive helpers', () => {
  it('obtiene identificadores de carpeta desde URL o ID', () => {
    expect(parseGoogleDriveFolderId('https://drive.google.com/drive/folders/abc_DEF-1234567890?usp=drive_link')).toBe('abc_DEF-1234567890');
    expect(parseGoogleDriveFolderId('abc_DEF-1234567890')).toBe('abc_DEF-1234567890');
    expect(parseGoogleDriveFolderId('invalido')).toBeNull();
  });

  it('clasifica archivos de reunión sin tratar grabaciones como transcripciones', () => {
    expect(classifyGoogleDriveArtifact('video/mp4', 'Llamada.mp4')).toBe('recording');
    expect(classifyGoogleDriveArtifact('application/vnd.google-apps.document', 'Transcripción reunión')).toBe('transcript');
    expect(classifyGoogleDriveArtifact('text/vtt', 'captions.vtt')).toBe('transcript');
    expect(canExtractGoogleDriveText('video/mp4', 'Llamada.mp4')).toBe(false);
    expect(canExtractGoogleDriveText('text/plain', 'resumen.txt')).toBe(true);
  });

  it('cifra los refresh tokens antes de persistirlos', () => {
    const key = 'a'.repeat(64);
    const encrypted = encryptGoogleDriveSecret('refresh-token', key);
    expect(encrypted).not.toContain('refresh-token');
    expect(decryptGoogleDriveSecret(encrypted, key)).toBe('refresh-token');
  });
});
