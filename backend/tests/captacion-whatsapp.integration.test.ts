// Aviso por WhatsApp de Captación contra PostgreSQL de QA local: el SQL real de esquema, solicitudes, barrido, envío
// y estados de Meta. Los escenarios del ticket, uno por bloque. ClickUp y la Cloud API van simulados.
// Trabaja en un esquema propio que se borra al terminar; no toca las tablas del esquema public.
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClienteClickUp, Tarea } from '../captacion-whatsapp/clickup.ts';
import { ErrorCloud, type Enviar } from '../captacion-whatsapp/cloud-api.ts';
import type { ConfigCaptacion } from '../captacion-whatsapp/config.ts';
import { aplicarEstados, aplicarWebhookClickUp, barrer, procesarAvisos } from '../captacion-whatsapp/proceso.ts';
import { ensureCaptacionWhatsApp } from '../captacion-whatsapp/schema.ts';

vi.mock('../netelip/processing.ts', () => ({ notifyTech: vi.fn(async () => undefined) }));

const databaseUrl = process.env.QA_TEST_DATABASE_URL;
const ESQUEMA = `captacion_whatsapp_test_${process.pid}`;
const ETAPA = { id: 'f-etapa', name: 'ETAPA_CRM', type: 'drop_down', type_config: { options: [
  { id: 'o1', name: 'e1 EN ESPERA', orderindex: 0 }, { id: 'o2', name: 'e2 CONTACTADO', orderindex: 1 }] } };

const config: ConfigCaptacion = {
  clickup: { token: 'pk', lista: '901211441576', campoEtapa: 'ETAPA_CRM', etapaEspera: 'e1 EN ESPERA', campoTelefono: 'contact_phone_number', campoPresupuesto: 'Presupuesto formulario', webhookSecret: 's' },
  cloud: { token: 't', versionApi: 'v23.0', plantilla: 'aviso_llamada', idioma: 'es_ES', appSecret: 's', verifyToken: 'v' },
  remitentes: { umbral: 100000, alto: { clave: 'alto', nombre: 'Ernesto', numeroId: 'n-ernesto' }, base: { clave: 'base', nombre: 'Victor', numeroId: 'n-victor' } },
  horario: null,
  caducidadMinutos: 720,
};

type Lt = { etapa: string; telefono: string | null; actualizada: number; parent?: string; presupuesto?: string; nombre?: string };

/** ClickUp simulado: un mapa de tareas con su etapa y teléfono. */
function clickupFalso(tareas: Map<string, Lt>): ClienteClickUp {
  const aTarea = (id: string): Tarea => {
    const t = tareas.get(id)!;
    return { id, name: t.nombre ?? `Lead ${id}`, parent: t.parent ?? null, list: { id: '901211441576' }, date_updated: String(t.actualizada),
      custom_fields: [{ id: 'f-etapa', name: 'ETAPA_CRM', value: t.etapa }, { id: 'f-tel', name: 'contact_phone_number', value: t.telefono }] };
  };
  return {
    etapaEspera: 'e1 EN ESPERA',
    campos: async () => ({ etapa: ETAPA, telefono: { id: 'f-tel', name: 'contact_phone_number' }, presupuesto: null }),
    tarea: async (id) => (tareas.has(id) ? aTarea(id) : null),
    esDeLaLista: () => true,
    enEspera: async () => [...tareas.keys()].filter((id) => tareas.get(id)!.etapa === 'o1' && !tareas.get(id)!.parent).map(aTarea),
    lead: async (t) => ({ taskId: t.id, nombre: t.name ?? null, telefono: tareas.get(t.id)!.telefono, etapa: tareas.get(t.id)!.etapa === 'o1' ? 'e1 EN ESPERA' : 'e2 CONTACTADO', presupuesto: tareas.get(t.id)!.presupuesto ?? null }),
  };
}

const cambio = (taskId: string, historyId: string, fecha: number, antes: string | null, despues: string) => ({
  event: 'taskUpdated', task_id: taskId,
  history_items: [{ id: historyId, date: String(fecha), field: 'custom_field', before: antes, after: despues, custom_field: { id: 'f-etapa', name: 'ETAPA_CRM' } }],
});

describe.skipIf(!databaseUrl)('Captación · WhatsApp a leads en espera en PostgreSQL QA local', () => {
  let pool: Pool;
  let tareas: Map<string, Lt>;
  let clickup: ClienteClickUp;
  const avisos = async (taskId?: string) => (await pool.query(
    `SELECT solicitud, clickup_task_id, origen, estado, motivo, telefono_e164, wamid, intentos, enviado_en, entregado_en, leido_en, fallido_en
     FROM captacion_whatsapp_avisos ${taskId ? 'WHERE clickup_task_id = $1' : ''} ORDER BY id`, taskId ? [taskId] : [])).rows;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    const localPort = url.port === '15439' || (process.env.CI === 'true' && url.port === '5432');
    if (url.hostname !== '127.0.0.1' || !localPort || url.pathname !== '/lyn_qa_retest') throw new Error('Solo QA local');
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${ESQUEMA}`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${ESQUEMA}` });
    await ensureCaptacionWhatsApp(pool);
    await ensureCaptacionWhatsApp(pool);   // idempotente
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE captacion_whatsapp_avisos, captacion_lead_espera, captacion_clickup_inbox; UPDATE captacion_estado SET linea_base_en = NULL, ultimo_barrido_en = NULL');
    tareas = new Map();
    clickup = clickupFalso(tareas);
  });

  it('línea base: los leads que ya estaban en e1 al activar el módulo no reciben nada', async () => {
    tareas.set('viejo', { etapa: 'o1', telefono: '612345678', actualizada: Date.parse('2026-10-01T10:00:00Z') });
    expect(await barrer(pool, clickup, new Date('2026-11-13T09:00:00Z'))).toEqual({ nuevas: 0, salidas: 0, linea_base: 1 });
    expect(await barrer(pool, clickup, new Date('2026-11-13T09:05:00Z'))).toEqual({ nuevas: 0, salidas: 0, linea_base: 0 });
    expect(await avisos()).toEqual([]);
  });

  it('Lead nuevo en espera: recibe la plantilla aprobada y queda registrado como enviado', async () => {
    await barrer(pool, clickup);   // línea base vacía
    tareas.set('t1', { etapa: 'o1', telefono: '+34 612 34 56 78', actualizada: Date.now() });
    expect(await aplicarWebhookClickUp(pool, clickup, cambio('t1', 'h1', Date.now(), 'o2', 'o1'))).toBe(1);
    const enviar = vi.fn<Enviar>().mockResolvedValue({ wamid: 'wamid.1' });
    expect(await procesarAvisos(pool, config, enviar)).toBe(1);
    expect(enviar).toHaveBeenCalledWith('+34612345678', 'n-victor');   // sin presupuesto: Victor
    expect(await avisos('t1')).toMatchObject([{ solicitud: 'clickup:t1:h1', origen: 'webhook', estado: 'enviado', wamid: 'wamid.1', telefono_e164: '+34612345678', intentos: 1 }]);
  });

  it('Sin duplicados: la misma solicitud procesada otra vez (webhook repetido o barrido) no reenvía', async () => {
    await barrer(pool, clickup);
    const entrada = Date.now() - 60_000;
    tareas.set('t1', { etapa: 'o1', telefono: '612345678', actualizada: entrada });
    expect(await aplicarWebhookClickUp(pool, clickup, cambio('t1', 'h1', entrada, 'o2', 'o1'))).toBe(1);
    expect(await aplicarWebhookClickUp(pool, clickup, cambio('t1', 'h1', entrada, 'o2', 'o1'))).toBe(0);
    expect((await barrer(pool, clickup)).nuevas).toBe(0);
    expect(await avisos('t1')).toHaveLength(1);
  });

  it('Sin duplicados: el barrido la ve antes que el webhook (atrasado) y sigue siendo una sola', async () => {
    await barrer(pool, clickup, new Date(Date.now() - 600_000));
    const entrada = Date.now() - 30_000;
    tareas.set('t1', { etapa: 'o1', telefono: '612345678', actualizada: entrada });
    expect((await barrer(pool, clickup)).nuevas).toBe(1);
    expect(await aplicarWebhookClickUp(pool, clickup, cambio('t1', 'h1', entrada, 'o2', 'o1'))).toBe(0);
    expect(await avisos('t1')).toMatchObject([{ origen: 'barrido' }]);
  });

  it('el lead sale de e1 y vuelve con una solicitud nueva: sí se envía otra vez', async () => {
    await barrer(pool, clickup);
    const t0 = Date.now() - 300_000;
    tareas.set('t1', { etapa: 'o1', telefono: '612345678', actualizada: t0 });
    await aplicarWebhookClickUp(pool, clickup, cambio('t1', 'h1', t0, 'o2', 'o1'));
    await aplicarWebhookClickUp(pool, clickup, cambio('t1', 'h2', t0 + 60_000, 'o1', 'o2'));
    expect(await aplicarWebhookClickUp(pool, clickup, cambio('t1', 'h3', t0 + 120_000, 'o2', 'o1'))).toBe(1);
    expect((await avisos('t1')).map((a) => a.solicitud)).toEqual(['clickup:t1:h1', 'clickup:t1:h3']);
  });

  it('se perdió el webhook de salida: una entrada posterior con otro history_item es una solicitud nueva', async () => {
    await barrer(pool, clickup);
    const t0 = Date.now() - 300_000;
    tareas.set('t1', { etapa: 'o1', telefono: '612345678', actualizada: t0 });
    await aplicarWebhookClickUp(pool, clickup, cambio('t1', 'h1', t0, 'o2', 'o1'));
    expect(await aplicarWebhookClickUp(pool, clickup, cambio('t1', 'h3', t0 + 120_000, 'o2', 'o1'))).toBe(1);
    // Y un webhook viejo que llega tarde no crea nada.
    expect(await aplicarWebhookClickUp(pool, clickup, cambio('t1', 'h0', t0 - 120_000, 'o2', 'o1'))).toBe(0);
    expect(await avisos('t1')).toHaveLength(2);
  });

  it('el barrido detecta la salida y la vuelta a e1 sin webhooks', async () => {
    await barrer(pool, clickup, new Date(Date.now() - 900_000));
    tareas.set('t1', { etapa: 'o1', telefono: '612345678', actualizada: Date.now() - 600_000 });
    expect((await barrer(pool, clickup, new Date(Date.now() - 600_000))).nuevas).toBe(1);
    tareas.get('t1')!.etapa = 'o2';
    expect((await barrer(pool, clickup, new Date(Date.now() - 300_000))).salidas).toBe(1);
    tareas.get('t1')!.etapa = 'o1';
    expect((await barrer(pool, clickup)).nuevas).toBe(1);
    expect(await avisos('t1')).toHaveLength(2);
  });

  it('subtareas y tareas de otras listas no cuentan', async () => {
    await barrer(pool, clickup);
    tareas.set('sub', { etapa: 'o1', telefono: '612345678', actualizada: Date.now(), parent: 't1' });
    expect(await aplicarWebhookClickUp(pool, clickup, cambio('sub', 'h1', Date.now(), 'o2', 'o1'))).toBe(0);
    expect((await barrer(pool, clickup)).nuevas).toBe(0);
    expect(await avisos()).toEqual([]);
  });

  it('Lead sin teléfono válido: no se envía y queda como no enviado con su motivo', async () => {
    await barrer(pool, clickup);
    tareas.set('sin', { etapa: 'o1', telefono: null, actualizada: Date.now() });
    tareas.set('malo', { etapa: 'o1', telefono: '12345', actualizada: Date.now() });
    tareas.set('fijo', { etapa: 'o1', telefono: '910000000', actualizada: Date.now() });
    expect((await barrer(pool, clickup)).nuevas).toBe(3);
    const enviar = vi.fn<Enviar>();
    await procesarAvisos(pool, config, enviar);
    expect(enviar).not.toHaveBeenCalled();
    const porLead = Object.fromEntries((await avisos()).map((a) => [a.clickup_task_id, a]));
    expect(porLead.sin).toMatchObject({ estado: 'no_enviado', motivo: expect.stringMatching(/^sin_telefono/) });
    expect(porLead.malo).toMatchObject({ estado: 'no_enviado', motivo: expect.stringMatching(/^telefono_no_valido/) });
    expect(porLead.fijo).toMatchObject({ estado: 'no_enviado', motivo: expect.stringMatching(/^telefono_fijo/) });
  });

  it('tareas de prueba del equipo («NO USAR», «prueba»): no se les escribe aunque el móvil sea válido', async () => {
    await barrer(pool, clickup);
    tareas.set('p1', { etapa: 'o1', telefono: '+34600000099', actualizada: Date.now(), nombre: 'prueba Mateo-Roger(NO USAR)', presupuesto: '40.000 € - 100.000 €' });
    tareas.set('p2', { etapa: 'o1', telefono: '612345678', actualizada: Date.now(), nombre: 'PRUEBA captación ABCD 9 (no usar)' });
    tareas.set('real', { etapa: 'o1', telefono: '612345679', actualizada: Date.now(), nombre: 'Pruebas Martínez' });
    expect((await barrer(pool, clickup)).nuevas).toBe(3);
    const enviar = vi.fn<Enviar>().mockResolvedValue({ wamid: 'wamid.real' });
    await procesarAvisos(pool, config, enviar);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar).toHaveBeenCalledWith('+34612345679', 'n-victor');
    const porLead = Object.fromEntries((await avisos()).map((a) => [a.clickup_task_id, a]));
    expect(porLead.p1).toMatchObject({ estado: 'no_enviado', motivo: expect.stringMatching(/^prueba:/), wamid: null });
    expect(porLead.p2).toMatchObject({ estado: 'no_enviado', motivo: expect.stringMatching(/^prueba:/) });
    expect(porLead.real).toMatchObject({ estado: 'enviado' });
  });

  it('Fallo de la API de WhatsApp: se reintenta y, si sigue fallando, queda fallido sin tocar el lead', async () => {
    await barrer(pool, clickup);
    tareas.set('t1', { etapa: 'o1', telefono: '612345678', actualizada: Date.now() });
    await barrer(pool, clickup);
    const enviar = vi.fn<Enviar>().mockRejectedValue(new ErrorCloud('La API de WhatsApp no responde', true, null));
    let ahora = Date.now();
    for (let i = 0; i < 4; i++) {
      await pool.query('UPDATE captacion_whatsapp_avisos SET siguiente_intento = NOW()');   // sin esperar al reintento
      await procesarAvisos(pool, config, enviar, new Date(ahora));
      ahora += 1000;
    }
    expect(enviar).toHaveBeenCalledTimes(4);
    expect(await avisos('t1')).toMatchObject([{ estado: 'fallido', intentos: 4, motivo: expect.stringMatching(/^envio_fallido/) }]);
    // El lead sigue en espera para el resto del sistema: ninguna escritura en ClickUp, que es de solo lectura.
    expect(tareas.get('t1')!.etapa).toBe('o1');
  });

  it('un error definitivo (plantilla inexistente) no se reintenta', async () => {
    await barrer(pool, clickup);
    tareas.set('t1', { etapa: 'o1', telefono: '612345678', actualizada: Date.now() });
    await barrer(pool, clickup);
    const enviar = vi.fn<Enviar>().mockRejectedValue(new ErrorCloud('HTTP 400 · código 132001', false, '132001'));
    await procesarAvisos(pool, config, enviar);
    expect(await avisos('t1')).toMatchObject([{ estado: 'fallido', intentos: 1 }]);
  });

  it('fuera de horario espera, sin Cloud API espera, y si pasa la caducidad ya no se envía', async () => {
    await barrer(pool, clickup);
    tareas.set('t1', { etapa: 'o1', telefono: '612345678', actualizada: Date.now() });
    await barrer(pool, clickup);
    const enviar = vi.fn<Enviar>().mockResolvedValue({ wamid: 'wamid.1' });
    await procesarAvisos(pool, { ...config, horario: { desde: 0, hasta: 0 } }, enviar);
    expect(await avisos('t1')).toMatchObject([{ estado: 'pendiente', motivo: expect.stringMatching(/^fuera_de_horario/) }]);
    await pool.query('UPDATE captacion_whatsapp_avisos SET siguiente_intento = NOW()');
    await procesarAvisos(pool, { ...config, cloud: null }, null);
    expect(await avisos('t1')).toMatchObject([{ estado: 'pendiente', motivo: expect.stringMatching(/^sin_configuracion/) }]);
    await pool.query(`UPDATE captacion_whatsapp_avisos SET siguiente_intento = NOW(), entrada_en = NOW() - INTERVAL '13 hours'`);
    await procesarAvisos(pool, config, enviar);
    expect(enviar).not.toHaveBeenCalled();
    expect(await avisos('t1')).toMatchObject([{ estado: 'no_enviado', motivo: expect.stringMatching(/^caducado/) }]);
  });

  it('Registro del envío: entregado y leído con su fecha, sin retroceder; failed de Meta lo marca fallido', async () => {
    await barrer(pool, clickup);
    tareas.set('t1', { etapa: 'o1', telefono: '612345678', actualizada: Date.now() });
    tareas.set('t2', { etapa: 'o1', telefono: '612345679', actualizada: Date.now() });
    await barrer(pool, clickup);
    const enviar = vi.fn<Enviar>().mockResolvedValueOnce({ wamid: 'wamid.1' }).mockResolvedValueOnce({ wamid: 'wamid.2' });
    await procesarAvisos(pool, config, enviar);
    const entregado = new Date('2026-11-13T10:00:00Z');
    const leido = new Date('2026-11-13T10:05:00Z');
    await aplicarEstados(pool, [{ wamid: 'wamid.1', estado: 'read', fecha: leido, error: null }]);
    await aplicarEstados(pool, [{ wamid: 'wamid.1', estado: 'delivered', fecha: entregado, error: null }]);   // atrasado
    await aplicarEstados(pool, [{ wamid: 'wamid.2', estado: 'failed', fecha: entregado, error: 'código 131026 · Message undeliverable' }]);
    await aplicarEstados(pool, [{ wamid: 'wamid.desconocido', estado: 'read', fecha: leido, error: null }]);
    const porLead = Object.fromEntries((await avisos()).map((a) => [a.clickup_task_id, a]));
    expect(porLead.t1).toMatchObject({ estado: 'leido', leido_en: leido, entregado_en: leido });
    expect(porLead.t2).toMatchObject({ estado: 'fallido', motivo: 'meta_failed: código 131026 · Message undeliverable', fallido_en: entregado });
  });

  it('remitente: desde 100.000 € sale del número de Ernesto; por debajo, del de Victor; queda registrado quién lo envió', async () => {
    await barrer(pool, clickup);
    tareas.set('alto', { etapa: 'o1', telefono: '612345678', actualizada: Date.now(), presupuesto: '100.000 € - 200.000 €' });
    tareas.set('bajo', { etapa: 'o1', telefono: '612345679', actualizada: Date.now(), presupuesto: '40.000 € - 100.000 €' });
    await barrer(pool, clickup);
    const enviar = vi.fn<Enviar>().mockImplementation(async (_t, numeroId) => ({ wamid: `wamid.${numeroId}` }));
    await procesarAvisos(pool, config, enviar);
    expect(enviar).toHaveBeenCalledWith('+34612345678', 'n-ernesto');
    expect(enviar).toHaveBeenCalledWith('+34612345679', 'n-victor');
    const filas = (await pool.query('SELECT clickup_task_id, presupuesto, remitente, remitente_numero_id FROM captacion_whatsapp_avisos ORDER BY clickup_task_id')).rows;
    expect(filas).toEqual([
      { clickup_task_id: 'alto', presupuesto: '100.000 € - 200.000 €', remitente: 'Ernesto', remitente_numero_id: 'n-ernesto' },
      { clickup_task_id: 'bajo', presupuesto: '40.000 € - 100.000 €', remitente: 'Victor', remitente_numero_id: 'n-victor' },
    ]);
  });

  it('remitente sin número en la Cloud API: el aviso espera, no sale de otro número', async () => {
    await barrer(pool, clickup);
    tareas.set('alto', { etapa: 'o1', telefono: '612345678', actualizada: Date.now(), presupuesto: 'Más de 200.000 €' });
    await barrer(pool, clickup);
    const enviar = vi.fn<Enviar>();
    await procesarAvisos(pool, { ...config, remitentes: { ...config.remitentes, alto: { ...config.remitentes.alto, numeroId: null } } }, enviar);
    expect(enviar).not.toHaveBeenCalled();
    expect(await avisos('alto')).toMatchObject([{ estado: 'pendiente', motivo: 'sin_configuracion: Ernesto aún no tiene número en la Cloud API' }]);
  });

  it('un lead creado directamente en e1 (taskCreated) y su webhook de cambio cuentan como una sola solicitud', async () => {
    await barrer(pool, clickup);
    const creado = Date.now() - 5_000;
    tareas.set('t1', { etapa: 'o1', telefono: '612345678', actualizada: creado + 1_000 });
    expect(await aplicarWebhookClickUp(pool, clickup, { event: 'taskCreated', task_id: 't1' })).toBe(1);
    expect(await aplicarWebhookClickUp(pool, clickup, cambio('t1', 'h1', creado + 1_000, null, 'o1'))).toBe(0);
    expect(await avisos('t1')).toHaveLength(1);
  });
});
