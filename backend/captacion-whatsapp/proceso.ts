// Procesado en segundo plano del aviso de Captación, todo sobre PostgreSQL con SKIP LOCKED:
//
//   procesarInbox     webhooks de ClickUp → entradas y salidas de e1 (crea el aviso pendiente)
//   barrer            leads en e1 según ClickUp → entradas que no llegaron por webhook, y salidas
//   procesarAvisos    avisos pendientes → teléfono, horario, envío de la plantilla con reintentos
//   aplicarEstados    webhooks de estado de Meta → entregado, leído o fallido
//
// Nada de esto modifica el lead en ClickUp ni bloquea su avance: un aviso fallido solo queda registrado.
import type { Pool } from 'pg';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { notifyTech } from '../netelip/processing.ts';
import { InvalidPhone, toE164 } from '../netelip/phone.ts';
import { cambiosDeEtapa, mismaEtapa, type ClienteClickUp, type Tarea, type WebhookClickUp } from './clickup.ts';
import { ErrorCloud, type Enviar, type EstadoMeta } from './cloud-api.ts';
import { dentroDeHorario, elegirRemitente, type ConfigCaptacion } from './config.ts';
import { fijarLineaBase, registrarEntrada, registrarSalida } from './solicitudes.ts';

type Db = Pick<Pool, 'query' | 'connect'>;

const INBOX_MAX_INTENTOS = 10;
/** Esperas entre intentos de envío: 4 intentos en total en unos 20 minutos. */
export const ESPERAS_REINTENTO_SEGUNDOS = [60, 300, 900];
const ESPERA_FUERA_DE_HORARIO_MS = 10 * 60_000;
const ESPERA_SIN_CLOUD_MS = 5 * 60_000;

const fechaTarea = (t: Tarea, ...extra: (string | number | undefined)[]) =>
  new Date(Math.max(...[t.date_updated, ...extra].map(Number).filter(Number.isFinite), 0));

// --- Webhooks de ClickUp -------------------------------------------------------------------------

export async function aceptarWebhookClickUp(pool: Pick<Pool, 'query'>, payload: unknown): Promise<void> {
  await pool.query('INSERT INTO captacion_clickup_inbox (payload) VALUES ($1)', [JSON.stringify(payload)]);
}

/** Aplica un webhook de ClickUp. Devuelve cuántas solicitudes nuevas creó. */
export async function aplicarWebhookClickUp(pool: Db, clickup: ClienteClickUp, payload: WebhookClickUp & { date_created?: string }): Promise<number> {
  const taskId = payload.task_id ? String(payload.task_id) : null;
  if (!taskId) return 0;
  const leadEnLista = async () => {
    const tarea = await clickup.tarea(taskId);
    if (!tarea || tarea.parent || !clickup.esDeLaLista(tarea)) return null;   // solo tareas padre de la lista
    return { tarea, lead: await clickup.lead(tarea) };
  };

  if (payload.event === 'taskCreated') {
    // Un lead creado ya en e1. La fecha es la de la última actualización leída: cualquier webhook de ese mismo
    // cambio de etapa que llegue después tendrá una fecha anterior o igual y contará como la misma solicitud.
    const encontrado = await leadEnLista();
    if (!encontrado || !mismaEtapa(encontrado.lead.etapa, clickup.etapaEspera)) return 0;
    const r = await registrarEntrada(pool, { taskId, solicitud: `clickup:${taskId}:creada`, origen: 'webhook',
      fecha: fechaTarea(encontrado.tarea, (encontrado.tarea as { date_created?: string }).date_created), lead: encontrado.lead });
    return r === 'nueva' ? 1 : 0;
  }
  if (payload.event !== 'taskUpdated') return 0;

  const { etapa } = await clickup.campos();
  const cambios = cambiosDeEtapa(payload, etapa, clickup.etapaEspera).sort((a, b) => a.fecha.getTime() - b.fecha.getTime());
  let nuevas = 0;
  for (const cambio of cambios) {
    if (cambio.sale) await registrarSalida(pool, taskId, cambio.fecha);
    if (!cambio.entra) continue;
    const encontrado = await leadEnLista();
    if (!encontrado) return nuevas;
    const r = await registrarEntrada(pool, { taskId, solicitud: `clickup:${taskId}:${cambio.historyId}`, origen: 'webhook', fecha: cambio.fecha, lead: encontrado.lead });
    if (r === 'nueva') nuevas++;
  }
  return nuevas;
}


type FilaInbox = { id: string; payload: WebhookClickUp; intentos: number };

/** Procesa un lote de la bandeja. Devuelve cuántas filas se terminaron (bien o mal). */
export async function procesarInbox(pool: Db, clickup: ClienteClickUp, limite = 20): Promise<number> {
  const { rows } = await pool.query<FilaInbox>(
    `UPDATE captacion_clickup_inbox SET intentos = intentos + 1, siguiente_intento = NOW() + INTERVAL '2 minutes'
     WHERE id IN (SELECT id FROM captacion_clickup_inbox WHERE estado = 'pendiente' AND siguiente_intento <= NOW()
                  ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, payload, intentos`, [limite]);
  for (const row of rows) {
    try {
      const nuevas = await aplicarWebhookClickUp(pool, clickup, row.payload);
      await pool.query(`UPDATE captacion_clickup_inbox SET estado = 'hecho', procesado_en = NOW(), ultimo_error = NULL, payload = '{}'::jsonb WHERE id = $1`, [row.id]);
      if (nuevas) console.log(JSON.stringify({ msg: 'captacion_solicitudes_nuevas', origen: 'webhook', task_id: row.payload.task_id, nuevas }));
    } catch (error) {
      const mensaje = (error as Error).message.slice(0, 500);
      const final = row.intentos >= INBOX_MAX_INTENTOS;
      // Espera creciente: 1, 2, 4… minutos (máx. 1 h). Mientras tanto, el barrido recoge la entrada si la hay.
      await pool.query(
        `UPDATE captacion_clickup_inbox SET estado = $2, ultimo_error = $3, siguiente_intento = NOW() + make_interval(mins => $4) WHERE id = $1`,
        [row.id, final ? 'fallido' : 'pendiente', mensaje, Math.min(2 ** (row.intentos - 1), 60)]);
      if (final) await notifyTech('Captación: webhook de ClickUp sin procesar', { inbox_id: row.id, error: mensaje });
    }
  }
  return rows.length;
}

// --- Barrido -------------------------------------------------------------------------------------

export async function barrer(pool: Db, clickup: ClienteClickUp, ahora = new Date()): Promise<{ nuevas: number; salidas: number; linea_base: number }> {
  const inicio = ahora;
  const tareas = await clickup.enEspera();
  const { rows: [estado] } = await pool.query<{ linea_base_en: Date | null }>('SELECT linea_base_en FROM captacion_estado');
  if (!estado?.linea_base_en) {
    await fijarLineaBase(pool, tareas.map((t) => t.id), inicio);
    return { nuevas: 0, salidas: 0, linea_base: tareas.length };
  }
  const enClickUp = new Set(tareas.map((t) => t.id));
  const { rows } = await pool.query<{ clickup_task_id: string; cambio_en: Date }>(
    'SELECT clickup_task_id, cambio_en FROM captacion_lead_espera WHERE en_espera');
  const yaEnEspera = new Set(rows.map((r) => r.clickup_task_id));
  let nuevas = 0;
  for (const tarea of tareas) {
    if (yaEnEspera.has(tarea.id)) continue;
    // Fecha: la mayor entre el inicio del barrido y la última actualización de la tarea (reloj de ClickUp), para
    // que el webhook de esta misma entrada, si llega después, cuente como la misma solicitud.
    const fecha = fechaTarea(tarea, inicio.getTime());
    const r = await registrarEntrada(pool, { taskId: tarea.id, solicitud: `barrido:${tarea.id}:${fecha.getTime()}`, origen: 'barrido', fecha, lead: await clickup.lead(tarea) });
    if (r === 'nueva') nuevas++;
  }
  let salidas = 0;
  for (const row of rows) {
    // Solo si ya estaba en espera antes de empezar el barrido: una entrada aplicada mientras tanto no se deshace.
    if (enClickUp.has(row.clickup_task_id) || row.cambio_en.getTime() >= inicio.getTime()) continue;
    if (await registrarSalida(pool, row.clickup_task_id, inicio)) salidas++;
  }
  await pool.query('UPDATE captacion_estado SET ultimo_barrido_en = $1', [inicio]);
  return { nuevas, salidas, linea_base: 0 };
}

// --- Envío ---------------------------------------------------------------------------------------

export type Telefono = { e164: string } | { motivo: string };

/** Teléfono para WhatsApp: E.164 válido y que no sea un fijo (los fijos no tienen WhatsApp). */
export function telefonoParaWhatsApp(original: string | null): Telefono {
  if (!original || !original.trim()) return { motivo: 'sin_telefono: el lead no tiene teléfono en ClickUp' };
  let e164: string;
  try {
    e164 = toE164(original);
  } catch (error) {
    if (error instanceof InvalidPhone) return { motivo: 'telefono_no_valido: el teléfono del lead no es un número válido' };
    throw error;
  }
  if (parsePhoneNumberFromString(e164)?.getType() === 'FIXED_LINE') return { motivo: 'telefono_fijo: el teléfono del lead es un fijo, sin WhatsApp' };
  return { e164 };
}

type FilaAviso = { id: string; clickup_task_id: string; entrada_en: Date; telefono_original: string | null; presupuesto: string | null; intentos: number };

/** Envía los avisos pendientes. Devuelve cuántos se trataron. */
export async function procesarAvisos(pool: Db, config: ConfigCaptacion, enviar: Enviar | null, ahora = new Date(), limite = 10): Promise<number> {
  const { rows } = await pool.query<FilaAviso>(
    `UPDATE captacion_whatsapp_avisos SET siguiente_intento = NOW() + INTERVAL '5 minutes'
     WHERE id IN (SELECT id FROM captacion_whatsapp_avisos WHERE estado = 'pendiente' AND siguiente_intento <= NOW()
                  ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, clickup_task_id, entrada_en, telefono_original, presupuesto, intentos`, [limite]);
  const actualizar = (id: string, sql: string, params: unknown[]) =>
    pool.query(`UPDATE captacion_whatsapp_avisos SET ${sql}, actualizado_en = NOW() WHERE id = $1`, [id, ...params]);
  const esperar = (id: string, ms: number, motivo: string) =>
    actualizar(id, 'siguiente_intento = $2, motivo = $3', [new Date(ahora.getTime() + ms), motivo]);

  for (const aviso of rows) {
    const telefono = telefonoParaWhatsApp(aviso.telefono_original);
    if ('motivo' in telefono) {
      await actualizar(aviso.id, `estado = 'no_enviado', motivo = $2`, [telefono.motivo]);
      continue;
    }
    if (ahora.getTime() - aviso.entrada_en.getTime() > config.caducidadMinutos * 60_000) {
      await actualizar(aviso.id, `estado = 'no_enviado', telefono_e164 = $2, motivo = $3`,
        [telefono.e164, `caducado: más de ${config.caducidadMinutos} min desde la entrada en espera sin poder enviarlo`]);
      continue;
    }
    // Sale del número del comercial que llamará: Ernesto con presupuesto >= umbral, Victor por debajo o sin él.
    const remitente = elegirRemitente(aviso.presupuesto, config.remitentes);
    if (!enviar || !config.cloud) {
      await esperar(aviso.id, ESPERA_SIN_CLOUD_MS, 'sin_configuracion: falta la configuración de la Cloud API de WhatsApp');
      continue;
    }
    if (!remitente.numeroId) {
      await esperar(aviso.id, ESPERA_SIN_CLOUD_MS, `sin_configuracion: ${remitente.nombre} aún no tiene número en la Cloud API`);
      continue;
    }
    if (!dentroDeHorario(config.horario, ahora)) {
      await esperar(aviso.id, ESPERA_FUERA_DE_HORARIO_MS, 'fuera_de_horario: se enviará al abrir la franja de envío');
      continue;
    }
    const intento = aviso.intentos + 1;
    try {
      const { wamid } = await enviar(telefono.e164, remitente.numeroId);
      await actualizar(aviso.id, `estado = 'enviado', intentos = $2, telefono_e164 = $3, wamid = $4, plantilla = $5, enviado_en = $6, motivo = NULL,
        remitente = $7, remitente_numero_id = $8`, [intento, telefono.e164, wamid, config.cloud.plantilla, ahora, remitente.nombre, remitente.numeroId]);
      console.log(JSON.stringify({ msg: 'captacion_aviso_enviado', aviso_id: aviso.id, task_id: aviso.clickup_task_id }));
    } catch (error) {
      const reintentable = !(error instanceof ErrorCloud) || error.reintentable;
      const mensaje = (error as Error).message.slice(0, 500);
      if (reintentable && intento <= ESPERAS_REINTENTO_SEGUNDOS.length) {
        await actualizar(aviso.id, 'intentos = $2, telefono_e164 = $3, motivo = $4, siguiente_intento = $5',
          [intento, telefono.e164, `reintento: ${mensaje}`, new Date(ahora.getTime() + ESPERAS_REINTENTO_SEGUNDOS[intento - 1] * 1000)]);
      } else {
        await actualizar(aviso.id, `estado = 'fallido', intentos = $2, telefono_e164 = $3, motivo = $4, fallido_en = $5, remitente = $6, remitente_numero_id = $7`,
          [intento, telefono.e164, `envio_fallido: ${mensaje}`, ahora, remitente.nombre, remitente.numeroId]);
        await notifyTech('Captación: aviso de WhatsApp fallido', { aviso_id: aviso.id, task_id: aviso.clickup_task_id, intentos: intento, error: mensaje });
      }
    }
  }
  return rows.length;
}

// --- Estados de Meta -----------------------------------------------------------------------------

/**
 * Aplica los estados de entrega. Nunca retrocede (leído no vuelve a entregado aunque los webhooks lleguen
 * desordenados) y un fallo de Meta posterior al envío marca el aviso como fallido con su código.
 */
export async function aplicarEstados(pool: Pick<Pool, 'query'>, estados: EstadoMeta[]): Promise<number> {
  let aplicados = 0;
  for (const e of estados) {
    let sql: string;
    let params: unknown[];
    if (e.estado === 'failed') {
      sql = `UPDATE captacion_whatsapp_avisos SET estado = 'fallido', fallido_en = $2, motivo = $3, actualizado_en = NOW()
             WHERE wamid = $1 AND estado IN ('pendiente','enviado','entregado')`;
      params = [e.wamid, e.fecha, `meta_failed: ${e.error ?? 'sin detalle'}`];
    } else if (e.estado === 'delivered') {
      sql = `UPDATE captacion_whatsapp_avisos SET estado = CASE WHEN estado = 'enviado' THEN 'entregado' ELSE estado END,
               entregado_en = COALESCE(entregado_en, $2), actualizado_en = NOW()
             WHERE wamid = $1 AND estado IN ('enviado','entregado','leido')`;
      params = [e.wamid, e.fecha];
    } else if (e.estado === 'read') {
      sql = `UPDATE captacion_whatsapp_avisos SET estado = 'leido', leido_en = COALESCE(leido_en, $2),
               entregado_en = COALESCE(entregado_en, $2), actualizado_en = NOW()
             WHERE wamid = $1 AND estado IN ('enviado','entregado','leido')`;
      params = [e.wamid, e.fecha];
    } else continue;   // sent: ya está como enviado desde la respuesta de la API
    const r = await pool.query(sql, params);
    aplicados += r.rowCount ?? 0;
  }
  return aplicados;
}
