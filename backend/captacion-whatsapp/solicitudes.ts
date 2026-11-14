// Una solicitud = una entrada del lead en «e1 EN ESPERA». Aquí se decide si una entrada es nueva (se crea el aviso)
// o la misma procesada otra vez (no se crea nada). Llegan entradas por dos caminos que pueden solaparse:
//
//   webhook  cada cambio de ETAPA_CRM trae su history_item (id y fecha). Mismo history_item = misma solicitud.
//   barrido  cada pocos minutos se listan los leads en e1; recoge los webhooks perdidos.
//
// captacion_lead_espera guarda, por lead, si está en espera y la fecha del último cambio aplicado (cambio_en).
// Una entrada con fecha F es la MISMA solicitud si el lead ya está en espera con cambio_en >= F (el barrido la vio
// después de que ocurriera, o es un webhook repetido o atrasado). Si está en espera desde ANTES de F, se perdió la
// salida: es una solicitud nueva. Todo bajo FOR UPDATE de la fila del lead, así webhook y barrido no se pisan.
import type { Pool, PoolClient } from 'pg';
import type { Lead } from './clickup.ts';

type Conectable = Pick<Pool, 'connect'>;

export type Entrada = {
  taskId: string;
  solicitud: string;
  origen: 'webhook' | 'barrido';
  fecha: Date;
  lead: Pick<Lead, 'nombre' | 'telefono' | 'presupuesto'>;
};

export type ResultadoEntrada = 'nueva' | 'repetida' | 'antigua';

async function enTransaccion<T>(pool: Conectable, trabajo: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await trabajo(client);
    await client.query('COMMIT');
    return resultado;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function bloquearLead(client: PoolClient, taskId: string) {
  await client.query(
    `INSERT INTO captacion_lead_espera (clickup_task_id, en_espera, cambio_en) VALUES ($1, FALSE, '1970-01-01T00:00:00Z')
     ON CONFLICT (clickup_task_id) DO NOTHING`, [taskId]);
  const { rows } = await client.query<{ en_espera: boolean; cambio_en: Date }>(
    'SELECT en_espera, cambio_en FROM captacion_lead_espera WHERE clickup_task_id = $1 FOR UPDATE', [taskId]);
  return rows[0];
}

export async function registrarEntrada(pool: Conectable, entrada: Entrada): Promise<ResultadoEntrada> {
  return enTransaccion(pool, async (client) => {
    const estado = await bloquearLead(client, entrada.taskId);
    const ya = await client.query('SELECT 1 FROM captacion_whatsapp_avisos WHERE solicitud = $1', [entrada.solicitud]);
    if (ya.rowCount) return 'repetida';
    if (estado.en_espera && estado.cambio_en.getTime() >= entrada.fecha.getTime()) return 'repetida';
    if (!estado.en_espera && estado.cambio_en.getTime() > entrada.fecha.getTime()) return 'antigua';   // salió después
    await client.query(
      `UPDATE captacion_lead_espera SET en_espera = TRUE, solicitud = $2, cambio_en = $3, actualizado_en = NOW()
       WHERE clickup_task_id = $1`, [entrada.taskId, entrada.solicitud, entrada.fecha]);
    await client.query(
      `INSERT INTO captacion_whatsapp_avisos (solicitud, clickup_task_id, origen, entrada_en, lead_nombre, telefono_original, presupuesto)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (solicitud) DO NOTHING`,
      [entrada.solicitud, entrada.taskId, entrada.origen, entrada.fecha, entrada.lead.nombre, entrada.lead.telefono, entrada.lead.presupuesto]);
    return 'nueva';
  });
}

/** El lead sale de e1. Un cambio más antiguo que el último aplicado no cuenta. */
export async function registrarSalida(pool: Conectable, taskId: string, fecha: Date): Promise<boolean> {
  return enTransaccion(pool, async (client) => {
    const estado = await bloquearLead(client, taskId);
    if (estado.cambio_en.getTime() > fecha.getTime()) return false;
    await client.query(
      'UPDATE captacion_lead_espera SET en_espera = FALSE, cambio_en = $2, actualizado_en = NOW() WHERE clickup_task_id = $1',
      [taskId, fecha]);
    return estado.en_espera;
  });
}

/**
 * Línea base: los leads que ya estaban en e1 al activar el módulo quedan en espera sin aviso. Sin esto, el primer
 * barrido escribiría a todos los leads antiguos en e1.
 */
export async function fijarLineaBase(pool: Conectable, taskIds: string[], ahora: Date): Promise<void> {
  await enTransaccion(pool, async (client) => {
    for (const taskId of taskIds) {
      await client.query(
        `INSERT INTO captacion_lead_espera (clickup_task_id, en_espera, solicitud, cambio_en) VALUES ($1, TRUE, 'linea_base', $2)
         ON CONFLICT (clickup_task_id) DO NOTHING`, [taskId, ahora]);
    }
    await client.query('UPDATE captacion_estado SET linea_base_en = $1, ultimo_barrido_en = $1', [ahora]);
  });
}
