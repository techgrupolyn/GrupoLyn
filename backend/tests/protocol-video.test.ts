import { describe, expect, it, vi } from 'vitest';
import { parseProtocolVideoCaptions } from '../protocol-video.ts';
import { syncProtocolDrive } from '../protocol-drive.ts';

const folderId = '14oB0TKbGyvEDMti2JgjXIep54-ZcMbc_';
const vtt = `WEBVTT\nKind: captions\nLanguage: es\n\n00:00:05.000 --> 00:00:09.000\nPrimero se comprueba la cocina\n\n00:00:34.000 --> 00:00:40.000\nDespués se revisa la encimera con el equipo\n`;

describe('videos de protocolos', () => {
  it('convierte subtítulos temporizados en secciones citables', () => {
    expect(parseProtocolVideoCaptions(vtt)).toEqual([
      { ref: 'video 00:00:00', text: 'Primero se comprueba la cocina' },
      { ref: 'video 00:00:30', text: 'Después se revisa la encimera con el equipo' },
    ]);
    expect(() => parseProtocolVideoCaptions('WEBVTT\n\n')).toThrow('no tiene subtítulos');
  });

  it('reutiliza la transcripción cacheada sin descargar el MP4', async () => {
    const entry = { id: 'video-123456', name: 'Cocinas.mp4', mimeType: 'video/mp4', version: '9', parents: [folderId] };
    const request = vi.fn(async (path: string) => {
      if (!path.startsWith('/files?')) throw new Error('No debe descargar el video');
      return Response.json({ files: [entry] });
    });
    const save = vi.fn(async () => undefined);
    const loadVideo = vi.fn(async () => parseProtocolVideoCaptions(vtt));
    const first = await syncProtocolDrive(request, { maxTokens: 1000, save, loadVideo });
    expect(first.error).toBeNull();
    expect(first.files[0]).toMatchObject({ status: 'con avisos', sections: 2 });
    const previous = save.mock.calls[0][0];
    const second = await syncProtocolDrive(request, { maxTokens: 1000, previous, save, loadVideo });
    expect(second.error).toBeNull();
    expect(loadVideo).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('conserva el corpus anterior si falta la pista de una revisión nueva', async () => {
    const request = vi.fn(async () => Response.json({ files: [{ id: 'video-123456', name: 'Cocinas.mp4', mimeType: 'video/mp4', version: '10', parents: [folderId] }] }));
    const save = vi.fn(async () => undefined);
    const report = await syncProtocolDrive(request, { maxTokens: 1000, save, loadVideo: async () => null });
    expect(report.error).toContain('se conserva el corpus anterior');
    expect(save).not.toHaveBeenCalled();
  });
});
