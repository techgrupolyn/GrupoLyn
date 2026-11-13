// Aviso por WhatsApp de Captación (lead en «e1 EN ESPERA»): piezas sin base de datos. ClickUp y la Cloud API van
// simuladas con las formas de sus respuestas (API v2 de ClickUp y Graph API de Meta).
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { cambiosDeEtapa, crearClienteClickUp, firmaClickUpValida, nombreOpcion } from '../captacion-whatsapp/clickup.ts';
import { crearEnviador, ErrorCloud, estadosDelWebhook, firmaMetaValida } from '../captacion-whatsapp/cloud-api.ts';
import { configCaptacionDesdeEnv, dentroDeHorario, parseHorario } from '../captacion-whatsapp/config.ts';
import { telefonoParaWhatsApp } from '../captacion-whatsapp/proceso.ts';

const OPCIONES = [{ id: 'o1', name: 'e1 EN ESPERA', orderindex: 0 }, { id: 'o2', name: 'e2 CONTACTADO', orderindex: 1 }];
const ETAPA = { id: 'f-etapa', name: 'ETAPA_CRM', type: 'drop_down', type_config: { options: OPCIONES } };
const respuesta = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('configuración', () => {
  it('apagado por defecto y sin token de ClickUp no arranca', () => {
    expect(configCaptacionDesdeEnv({ CLICKUP_API_TOKEN: 'pk' })).toBeNull();
    expect(configCaptacionDesdeEnv({ CAPTACION_WHATSAPP_ENABLED: 'true' })).toBeNull();
  });
  it('valores del ticket por defecto; Cloud API solo con token, número y plantilla', () => {
    const c = configCaptacionDesdeEnv({ CAPTACION_WHATSAPP_ENABLED: 'true', CLICKUP_API_TOKEN: 'pk' })!;
    expect(c.clickup).toMatchObject({ lista: '901211441576', campoEtapa: 'ETAPA_CRM', etapaEspera: 'e1 EN ESPERA', campoTelefono: 'contact_phone_number' });
    expect(c.cloud).toBeNull();
    expect(c.horario).toBeNull();
    const conCloud = configCaptacionDesdeEnv({ CAPTACION_WHATSAPP_ENABLED: 'true', CLICKUP_API_TOKEN: 'pk', WHATSAPP_CLOUD_TOKEN: 't', WHATSAPP_CLOUD_PHONE_NUMBER_ID: '123', CAPTACION_WHATSAPP_PLANTILLA: 'aviso_llamada' })!;
    expect(conCloud.cloud).toMatchObject({ plantilla: 'aviso_llamada', idioma: 'es_ES', versionApi: 'v23.0' });
  });
  it('franja horaria en hora de Madrid, también cruzando la medianoche', () => {
    expect(() => parseHorario('9-21')).toThrow();
    const dia = parseHorario('09:00-21:00');
    // 13/11/2026: Madrid en UTC+1.
    expect(dentroDeHorario(dia, new Date('2026-11-13T07:59:00Z'))).toBe(false);   // 08:59
    expect(dentroDeHorario(dia, new Date('2026-11-13T08:00:00Z'))).toBe(true);    // 09:00
    expect(dentroDeHorario(dia, new Date('2026-11-13T20:00:00Z'))).toBe(false);   // 21:00
    const noche = parseHorario('22:00-02:00');
    expect(dentroDeHorario(noche, new Date('2026-11-13T23:30:00Z'))).toBe(true);  // 00:30
    expect(dentroDeHorario(null, new Date())).toBe(true);
  });
});

describe('webhooks de ClickUp', () => {
  it('firma HMAC-SHA256 del cuerpo crudo', () => {
    const cuerpo = Buffer.from('{"event":"taskUpdated"}');
    const firma = createHmac('sha256', 'secreto').update(cuerpo).digest('hex');
    expect(firmaClickUpValida(cuerpo, firma, 'secreto')).toBe(true);
    expect(firmaClickUpValida(cuerpo, firma, 'otro')).toBe(false);
    expect(firmaClickUpValida(cuerpo, undefined, 'secreto')).toBe(false);
    expect(firmaClickUpValida(cuerpo, 'zz', 'secreto')).toBe(false);
  });

  it('nombre de la opción por id, orderindex u objeto', () => {
    expect(nombreOpcion('o1', OPCIONES)).toBe('e1 EN ESPERA');
    expect(nombreOpcion(1, OPCIONES)).toBe('e2 CONTACTADO');
    expect(nombreOpcion({ id: 'o1' }, OPCIONES)).toBe('e1 EN ESPERA');
    expect(nombreOpcion(null, OPCIONES)).toBeNull();
    expect(nombreOpcion('0b8f0c1e-1111-2222-3333-444455556666', OPCIONES)).toBeNull();
  });

  it('solo cuentan los cambios de ETAPA_CRM que entran en e1 o salen de e1', () => {
    const cambios = cambiosDeEtapa({ event: 'taskUpdated', task_id: 't1', history_items: [
      { id: 'h1', date: '1763020800000', field: 'custom_field', before: 'o2', after: 'o1', custom_field: { id: 'f-etapa', name: 'ETAPA_CRM' } },
      { id: 'h2', date: '1763020900000', field: 'custom_field', before: 'o1', after: 'o2', custom_field: { id: 'f-etapa', name: 'ETAPA_CRM' } },
      { id: 'h3', date: '1763021000000', field: 'custom_field', before: null, after: 'o2', custom_field: { id: 'f-etapa', name: 'ETAPA_CRM' } },
      { id: 'h4', date: '1763021100000', field: 'status', before: 'a', after: 'b' },
      { id: 'h5', date: '1763021200000', field: 'custom_field', before: null, after: 0, custom_field: { id: 'otro', name: 'Origen' } },
    ] }, ETAPA, 'e1 EN ESPERA');
    expect(cambios).toEqual([
      { historyId: 'h1', fecha: new Date(1763020800000), entra: true, sale: false },
      { historyId: 'h2', fecha: new Date(1763020900000), entra: false, sale: true },
    ]);
  });
});

describe('cliente de ClickUp', () => {
  const config = { token: 'pk', lista: '901211441576', campoEtapa: 'ETAPA_CRM', etapaEspera: 'e1 EN ESPERA', campoTelefono: 'contact_phone_number', webhookSecret: null };
  const CAMPOS = { fields: [ETAPA, { id: 'f-tel', name: 'contact_phone_number', type: 'phone' }] };
  const tarea = (id: string, etapa: string | null, parent: string | null = null) =>
    ({ id, name: `Lead ${id}`, parent, custom_fields: [{ id: 'f-etapa', name: 'ETAPA_CRM', value: etapa }, { id: 'f-tel', name: 'contact_phone_number', value: '+34 612 34 56 78' }] });

  it('lista los leads en e1 por todas las páginas, solo tareas padre, y lee nombre y teléfono', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(respuesta(CAMPOS))
      .mockResolvedValueOnce(respuesta({ tasks: [tarea('a', 'o1'), tarea('sub', 'o1', 'a'), tarea('b', 'o2')], last_page: false }))
      .mockResolvedValueOnce(respuesta({ tasks: [tarea('c', 'o1')], last_page: true }));
    const cliente = crearClienteClickUp(config, fetcher as unknown as typeof fetch);
    const tareas = await cliente.enEspera();
    expect(tareas.map((t) => t.id)).toEqual(['a', 'c']);
    const url = new URL(fetcher.mock.calls[1][0]);
    expect(url.pathname).toBe('/api/v2/list/901211441576/task');
    expect(JSON.parse(url.searchParams.get('custom_fields')!)).toEqual([{ field_id: 'f-etapa', operator: '=', value: 'o1' }]);
    expect(url.searchParams.get('page')).toBe('0');
    expect(new URL(fetcher.mock.calls[2][0]).searchParams.get('page')).toBe('1');
    expect(fetcher.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);   // solo lectura
    expect(await cliente.lead(tareas[0])).toEqual({ taskId: 'a', nombre: 'Lead a', telefono: '+34 612 34 56 78', etapa: 'e1 EN ESPERA' });
  });

  it('sin la opción de espera en el campo, falla en vez de no encontrar nada', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(respuesta({ fields: [{ ...ETAPA, type_config: { options: [OPCIONES[1]] } }] }));
    await expect(crearClienteClickUp(config, fetcher as unknown as typeof fetch).enEspera()).rejects.toThrow('e1 EN ESPERA');
  });
});

describe('teléfono del lead', () => {
  it('móvil válido → E.164; sin teléfono, no válido o fijo → no se envía, con su motivo', () => {
    expect(telefonoParaWhatsApp('612 34 56 78')).toEqual({ e164: '+34612345678' });
    expect(telefonoParaWhatsApp('0034612345678')).toEqual({ e164: '+34612345678' });
    expect(telefonoParaWhatsApp(null)).toEqual({ motivo: expect.stringMatching(/^sin_telefono/) });
    expect(telefonoParaWhatsApp('  ')).toEqual({ motivo: expect.stringMatching(/^sin_telefono/) });
    expect(telefonoParaWhatsApp('12345')).toEqual({ motivo: expect.stringMatching(/^telefono_no_valido/) });
    expect(telefonoParaWhatsApp('910 00 00 00')).toEqual({ motivo: expect.stringMatching(/^telefono_fijo/) });
  });
});

describe('Cloud API', () => {
  const cloud = { token: 'EAAT', phoneNumberId: '1098', versionApi: 'v23.0', plantilla: 'aviso_llamada', idioma: 'es_ES', appSecret: 's', verifyToken: 'v' };

  it('envía la plantilla aprobada al número sin «+» y devuelve el wamid', async () => {
    const fetcher = vi.fn().mockResolvedValue(respuesta({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.ABC' }] }));
    await expect(crearEnviador(cloud, fetcher as unknown as typeof fetch)('+34612345678')).resolves.toEqual({ wamid: 'wamid.ABC' });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v23.0/1098/messages');
    expect(init.headers.Authorization).toBe('Bearer EAAT');
    expect(JSON.parse(init.body)).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '34612345678', type: 'template',
      template: { name: 'aviso_llamada', language: { code: 'es_ES' } } });
  });

  it('caída, 5xx y límites de Meta se reintentan; un error de plantilla o de destinatario no', async () => {
    const enviar = (r: Response | Error) => crearEnviador(cloud, vi.fn().mockImplementation(async () => { if (r instanceof Error) throw r; return r; }) as unknown as typeof fetch)('+34612345678');
    const error = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ErrorCloud; } throw new Error('no falló'); };
    expect((await error(enviar(new Error('ECONNRESET')))).reintentable).toBe(true);
    expect((await error(enviar(respuesta({ error: { code: 131000, message: 'Something went wrong' } }, 500)))).reintentable).toBe(true);
    expect((await error(enviar(respuesta({ error: { code: 130429, message: 'Rate limit hit' } }, 400)))).reintentable).toBe(true);
    const plantilla = await error(enviar(respuesta({ error: { code: 132001, message: 'Template name does not exist in the translation' } }, 400)));
    expect(plantilla.reintentable).toBe(false);
    expect(plantilla.codigo).toBe('132001');
    expect(plantilla.message).toContain('Template name does not exist');
  });

  it('firma de Meta (X-Hub-Signature-256) y estados del webhook', () => {
    const body = { object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      statuses: [
        { id: 'wamid.A', status: 'delivered', timestamp: '1763020800', recipient_id: '34612345678' },
        { id: 'wamid.B', status: 'failed', timestamp: '1763020801', errors: [{ code: 131026, title: 'Message undeliverable' }] },
        { id: 'wamid.C', status: 'deleted', timestamp: '1763020802' },
      ],
      messages: [{ from: '34612345678', id: 'wamid.IN', type: 'text', text: { body: 'ok' } }],
    } }] }] };
    const crudo = Buffer.from(JSON.stringify(body));
    expect(firmaMetaValida(crudo, `sha256=${createHmac('sha256', 's').update(crudo).digest('hex')}`, 's')).toBe(true);
    expect(firmaMetaValida(crudo, `sha256=${createHmac('sha256', 'x').update(crudo).digest('hex')}`, 's')).toBe(false);
    expect(firmaMetaValida(crudo, 'sha1=abc', 's')).toBe(false);
    expect(estadosDelWebhook(body)).toEqual([
      { wamid: 'wamid.A', estado: 'delivered', fecha: new Date(1763020800000), error: null },
      { wamid: 'wamid.B', estado: 'failed', fecha: new Date(1763020801000), error: 'código 131026 · Message undeliverable' },
    ]);
    expect(estadosDelWebhook({})).toEqual([]);
  });
});

describe('receptores de webhooks', async () => {
  const request = (await import('supertest')).default;
  const express = (await import('express')).default;
  const { crearRouterWebhooks } = await import('../captacion-whatsapp/rutas.ts');
  const env = { CAPTACION_WHATSAPP_ENABLED: 'true', CLICKUP_API_TOKEN: 'pk', CAPTACION_CLICKUP_WEBHOOK_SECRET: 'sc',
    WHATSAPP_CLOUD_TOKEN: 't', WHATSAPP_CLOUD_PHONE_NUMBER_ID: '1', CAPTACION_WHATSAPP_PLANTILLA: 'p', WHATSAPP_CLOUD_APP_SECRET: 'sm', WHATSAPP_CLOUD_VERIFY_TOKEN: 'vt' };
  const montar = (config: ReturnType<typeof configCaptacionDesdeEnv>) => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const kick = vi.fn();
    const app = express();
    app.use(crearRouterWebhooks({ query } as never, config, kick));
    app.use(express.json());   // como en server.ts: después de los receptores
    return { app, query, kick };
  };

  it('apagado: 404 en todo', async () => {
    const { app } = montar(null);
    expect((await request(app).post('/webhook/captacion/clickup').send({})).status).toBe(404);
    expect((await request(app).post('/webhook/whatsapp-cloud').send({})).status).toBe(404);
    expect((await request(app).get('/webhook/whatsapp-cloud')).status).toBe(404);
  });

  it('ClickUp: sin firma válida 401; con firma, a la bandeja y aviso al proceso', async () => {
    const { app, query, kick } = montar(configCaptacionDesdeEnv(env));
    const cuerpo = JSON.stringify({ event: 'taskUpdated', task_id: 't1', history_items: [] });
    expect((await request(app).post('/webhook/captacion/clickup').set('content-type', 'application/json').set('x-signature', 'ab').send(cuerpo)).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    const firma = createHmac('sha256', 'sc').update(cuerpo).digest('hex');
    const ok = await request(app).post('/webhook/captacion/clickup').set('content-type', 'application/json').set('x-signature', firma).send(cuerpo);
    expect(ok.status).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('captacion_clickup_inbox'), [cuerpo]);
    expect(kick).toHaveBeenCalled();
  });

  it('ClickUp sin secreto configurado: 503, nunca un receptor abierto', async () => {
    const { app } = montar(configCaptacionDesdeEnv({ ...env, CAPTACION_CLICKUP_WEBHOOK_SECRET: '' }));
    expect((await request(app).post('/webhook/captacion/clickup').send({})).status).toBe(503);
  });

  it('Meta: verificación GET con el verify token y estados firmados con el App Secret', async () => {
    const { app, query } = montar(configCaptacionDesdeEnv(env));
    expect((await request(app).get('/webhook/whatsapp-cloud').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': '42' })).text).toBe('42');
    expect((await request(app).get('/webhook/whatsapp-cloud').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '42' })).status).toBe(403);
    const cuerpo = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.A', status: 'delivered', timestamp: '1763020800' }] } }] }] });
    expect((await request(app).post('/webhook/whatsapp-cloud').set('content-type', 'application/json').set('x-hub-signature-256', 'sha256=00').send(cuerpo)).status).toBe(401);
    const firma = `sha256=${createHmac('sha256', 'sm').update(cuerpo).digest('hex')}`;
    expect((await request(app).post('/webhook/whatsapp-cloud').set('content-type', 'application/json').set('x-hub-signature-256', firma).send(cuerpo)).status).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('entregado'), ['wamid.A', new Date(1763020800000)]);
  });
});
