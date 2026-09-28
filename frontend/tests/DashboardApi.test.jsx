import { afterEach, describe, expect, it, vi } from 'vitest';
import api from '../src/ceo-dashboard/api';

afterEach(() => vi.unstubAllGlobals());

describe('B-02: errores legibles', () => {
  it('extrae el mensaje sin mostrar JSON crudo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, text: async () => '{"error":"Falta responsable"}' }));
    await expect(api.meetings.list()).rejects.toMatchObject({ body: 'Falta responsable', status: 409 });
  });

  it('no muestra HTML del proxy ni respuestas técnicas inesperadas', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => '<html>nginx internal upstream details</html>' }));
    await expect(api.meetings.list()).rejects.toMatchObject({ body: 'No se pudo completar la operación. Vuelve a intentarlo.', status: 502 });
  });
});
