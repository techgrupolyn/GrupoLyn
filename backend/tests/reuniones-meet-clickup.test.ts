// Búsqueda del lead en ClickUp (869fppbcj) con la API simulada: no hay acceso real a «Contacto de Reforma».
// Las formas de las respuestas siguen la API v2 de ClickUp (campos de la lista y tareas filtradas por campo).
import { describe, expect, it, vi } from 'vitest';
import { configClickUpDesdeEnv, crearBuscadorLeads, ErrorClickUp, valorDesplegable } from '../reuniones-meet/clickup.ts';
import { faseDeEtapa, mapaEtapas } from '../reuniones-meet/reglas.ts';

const CAMPOS = { fields: [
  { id: 'f-email', name: 'email', type: 'email' },
  { id: 'f-tel', name: 'contact_phone_number', type: 'phone' },
  { id: 'f-etapa', name: 'ETAPA_CRM', type: 'drop_down', type_config: { options: [
    { id: 'o1', name: 'e1 EN ESPERA', orderindex: 0 }, { id: 'o4', name: 'e4 VISITA', orderindex: 3 }] } },
] };
const tarea = (id: string, email: string, etapa: number | null, parent: string | null = null) =>
  ({ id, parent, custom_fields: [{ id: 'f-email', name: 'email', value: email }, { id: 'f-etapa', name: 'ETAPA_CRM', value: etapa }] });
const respuesta = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const config = { token: 'pk_test', lista: '901211441576', campoEmail: 'email', campoEtapa: 'ETAPA_CRM' };

describe('configuración', () => {
  it('sin token no hay búsqueda; con token, los nombres del ticket por defecto y cambiables', () => {
    expect(configClickUpDesdeEnv({})).toBeNull();
    expect(crearBuscadorLeads(null)).toBeNull();
    expect(configClickUpDesdeEnv({ CLICKUP_API_TOKEN: 'pk' })).toEqual({ token: 'pk', lista: '901211441576', campoEmail: 'email', campoEtapa: 'ETAPA_CRM' });
    expect(configClickUpDesdeEnv({ CLICKUP_API_TOKEN: 'pk', REUNIONES_MEET_CLICKUP_CAMPO_EMAIL: 'Email cliente' })?.campoEmail).toBe('Email cliente');
  });
});

describe('crearBuscadorLeads', () => {
  it('busca por el campo de email, solo tareas padre, sin mayúsculas, y devuelve la etapa por su nombre', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(respuesta(CAMPOS))
      .mockResolvedValueOnce(respuesta({ tasks: [tarea('86lead', 'Garcia@Example.com', 3), tarea('86sub', 'garcia@example.com', 3, '86lead'), tarea('86otro', 'otra@example.com', 0)] }));
    const buscar = crearBuscadorLeads(config, fetcher as unknown as typeof fetch)!;
    expect(await buscar(['garcia@example.com'])).toEqual([{ id: '86lead', etapa: 'e4 VISITA' }]);
    const [urlCampos, init] = fetcher.mock.calls[0];
    expect(urlCampos).toBe('https://api.clickup.com/api/v2/list/901211441576/field');
    expect(init.headers.Authorization).toBe('pk_test');
    expect(init.method).toBeUndefined();   // solo lectura
    const url = new URL(fetcher.mock.calls[1][0]);
    expect(url.pathname).toBe('/api/v2/list/901211441576/task');
    expect(url.searchParams.get('subtasks')).toBe('false');
    expect(JSON.parse(url.searchParams.get('custom_fields')!)).toEqual([{ field_id: 'f-email', operator: '=', value: 'garcia@example.com' }]);
  });

  it('los campos de la lista se piden una sola vez; una tarea con el mismo lead en dos emails cuenta una vez', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(respuesta(CAMPOS))
      .mockResolvedValueOnce(respuesta({ tasks: [tarea('86lead', 'a@x.com', 3)] }))
      .mockResolvedValueOnce(respuesta({ tasks: [tarea('86lead', 'b@x.com', 3)] }))
      .mockResolvedValueOnce(respuesta({ tasks: [] }));
    const buscar = crearBuscadorLeads(config, fetcher as unknown as typeof fetch)!;
    expect(await buscar(['a@x.com', 'b@x.com'])).toEqual([{ id: '86lead', etapa: 'e4 VISITA' }]);
    expect(await buscar(['c@x.com'])).toEqual([]);
    expect(fetcher.mock.calls.filter(([u]) => String(u).endsWith('/field'))).toHaveLength(1);
  });

  it('si la lista no tiene el campo de email o ClickUp falla, lanza (y la reunión sigue pendiente)', async () => {
    const sinCampo = vi.fn().mockResolvedValue(respuesta({ fields: [{ id: 'x', name: 'Otro' }] }));
    await expect(crearBuscadorLeads(config, sinCampo as unknown as typeof fetch)!(['a@x.com'])).rejects.toThrow('no tiene el campo «email»');
    const caido = vi.fn().mockResolvedValue(respuesta({ err: 'Token invalid' }, 401));
    const error = await crearBuscadorLeads(config, caido as unknown as typeof fetch)!(['a@x.com']).catch((e) => e);
    expect(error).toBeInstanceOf(ErrorClickUp);
    expect(error.status).toBe(401);
  });

  it('valorDesplegable: por orderindex, por id de opción o sin valor', () => {
    const opciones = CAMPOS.fields[2].type_config!.options;
    expect(valorDesplegable({ id: 'f', name: 'ETAPA_CRM', value: 3 }, opciones)).toBe('e4 VISITA');
    expect(valorDesplegable({ id: 'f', name: 'ETAPA_CRM', value: 'o1' }, opciones)).toBe('e1 EN ESPERA');
    expect(valorDesplegable({ id: 'f', name: 'ETAPA_CRM', value: null }, opciones)).toBeNull();
  });
});

describe('fase desde la etapa del CRM', () => {
  it('por defecto solo e4 = F2 (lo único que dice el ticket); F3 y F4 se añaden por configuración', () => {
    expect(faseDeEtapa('e4 VISITA', mapaEtapas({}))).toBe('F2');
    expect(faseDeEtapa('E4', mapaEtapas({}))).toBe('F2');
    expect(faseDeEtapa('e6 PRESENTACIÓN', mapaEtapas({}))).toBeNull();
    const mapa = mapaEtapas({ REUNIONES_MEET_ETAPAS: 'e6:F3, e9:f4, e2:F9' });
    expect([faseDeEtapa('e6 PRESENTACIÓN', mapa), faseDeEtapa('e9 CIERRE', mapa), faseDeEtapa('e2 X', mapa)]).toEqual(['F3', 'F4', null]);
    expect(faseDeEtapa(null, mapa)).toBeNull();
  });
});
