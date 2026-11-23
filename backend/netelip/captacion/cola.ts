// Captación ABCD · flujo automático (N-1.2 con N-1.3 y N-1.4): cada llamada transcrita entra en una cola y un procesador la evalúa con el
// mismo núcleo que el lote, con reintentos, cola de errores y cola «sin lead». Mismo patrón que el calificador de Juan: PostgreSQL y
// `FOR UPDATE SKIP LOCKED`, sin broker externo.
//
// Orden y exclusión (lo que exige el resumen incremental de N-1.3 y la decisión de N-1.4):
// - Una sola llamada a la vez en todo el sistema (cerrojo de sesión de Postgres), y por orden de fecha de la llamada.
// - Una llamada espera a que terminen las ANTERIORES del mismo teléfono: así el resumen de una llamada parte del de la anterior.
//
// Apagado por defecto: ver `configColaDesdeEnv`. Escribir en ClickUp exige además una variable aparte; sin ella todo queda guardado en la
// base (simulacro) y ClickUp no se toca.
import type { Pool } from 'pg';
import type { Evaluador } from '../calificador/modelo.ts';
import { DURACION_MINIMA_SEGUNDOS, transcripcionPorTurnos, type Segmento } from '../calificador/reglas.ts';
import {
  aLeadCandidato, ClickUpEscrituraParcial, escribirPlan, NOMBRES_CAMPOS, planEscritura,
  type CampoLista, type ClickUpClient, type TareaClickUp,
} from './clickup.ts';
import { esVivo, numeroDeEtapa, sembrarAlcanceProvisional, sembrarPresupuestoFormulario } from './lote.ts';
import { evaluarLlamadaCaptacion, type EntradaLlamada, type ResultadoLlamada } from './proceso.ts';
import { bloquearLead, enTransaccion, recalcularLead, type Db } from './repositorio.ts';
import type { LeadCandidato } from './vinculacion.ts';

export const MAX_INTENTOS_COLA = 3;
/** Espera tras el 1.º y el 2.º fallo del modelo (segundos). El 3.º es el último: la llamada pasa a la cola de errores. */
export const ESPERA_REINTENTO_SEGUNDOS = [60, 300] as const;
/** Veces que una llamada sin lead se vuelve a mirar (por si el lead se creó después) y horas entre una y otra. */
export const MAX_VECES_SIN_LEAD = 3;
export const ESPERA_SIN_LEAD_HORAS = 6;
/** Una llamada reclamada que no termina (el servicio se cayó) vuelve a estar disponible pasado este tiempo. */
const RESERVA_MINUTOS = 10;
const ESPERA_CLICKUP_MINUTOS = 5;
/** Espacio del cerrojo de sesión que garantiza un solo procesador a la vez (el de los cerrojos por lead es el 7101). */
export const CERROJO_COLA = 7102;
export const VIGENCIA_LEADS_MS = 5 * 60_000;

// ---------------------------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------------------------

export interface ConfigCola {
  /** CAPTACION_WORKER_ENABLED=true: sin ella no se encola ni se procesa nada. */
  activa: boolean;
  /** CAPTACION_ESCRIBIR_CLICKUP=true: sin ella el flujo guarda en la base y no escribe en ClickUp (simulacro). */
  escribirClickUp: boolean;
}

export function configColaDesdeEnv(env: NodeJS.ProcessEnv = process.env): ConfigCola {
  return { activa: env.CAPTACION_WORKER_ENABLED === 'true', escribirClickUp: env.CAPTACION_ESCRIBIR_CLICKUP === 'true' };
}

// ---------------------------------------------------------------------------------------------
// Encolar
// ---------------------------------------------------------------------------------------------

/** Mete una llamada transcrita (≥ 60 s) en la cola. Idempotente: un aviso repetido no la duplica. Devuelve true si es nueva. */
export async function encolarCaptacion(pool: Pick<Pool, 'query'>, llamadaId: number | string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO captacion_cola (llamada_id, ocurrida_en)
     SELECT c.id::text, c.occurred_at
     FROM netelip_calls c JOIN netelip_call_transcriptions t ON t.call_id = c.id AND t.status = 'completed'
     WHERE c.id = $1::bigint AND c.duration_seconds >= $2
     ON CONFLICT (llamada_id) DO NOTHING`,
    [llamadaId, DURACION_MINIMA_SEGUNDOS],
  );
  return Boolean(rowCount);
}

/** Recupera las llamadas transcritas en los últimos `dias` días que no llegaron a la cola (un aviso perdido, un reinicio). */
export async function encolarPendientesCaptacion(pool: Pick<Pool, 'query'>, dias = 2): Promise<number> {
  const { rowCount } = await pool.query(
    `INSERT INTO captacion_cola (llamada_id, ocurrida_en)
     SELECT c.id::text, c.occurred_at
     FROM netelip_calls c JOIN netelip_call_transcriptions t ON t.call_id = c.id AND t.status = 'completed'
     WHERE c.duration_seconds >= $1 AND t.completed_at >= now() - make_interval(days => $2)
     ON CONFLICT (llamada_id) DO NOTHING`,
    [DURACION_MINIMA_SEGUNDOS, dias],
  );
  return rowCount || 0;
}

// ---------------------------------------------------------------------------------------------
// Procesador
// ---------------------------------------------------------------------------------------------

export interface DependenciasCola {
  pool: Pool;
  cliente: Pick<ClickUpClient, 'campos' | 'tareas' | 'escribirCampo'>;
  evaluar: Evaluador;
  /** false = simulacro: se guarda todo en la base y no se escribe nada en ClickUp. */
  escribir: boolean;
  /** Aviso a tecnología cuando una llamada agota sus intentos. */
  avisar?: (asunto: string, detalle: Record<string, unknown>) => Promise<void>;
  registro?: (mensaje: string) => void;
  ahora?: () => number;
  vigenciaLeadsMs?: number;
}

export type SalidaCola = 'procesada' | 'sin_lead' | 'sin_conversacion' | 'reintento' | 'error' | 'esperando_clickup';

interface Reclamada { llamada_id: string; intentos: number; sin_lead_veces: number }

interface FilaLlamada {
  id: string; occurred_at: Date; direction: string; phone_e164: string | null; duration_seconds: number;
  text: string | null; segments: Segmento[] | null;
}

interface Instantanea {
  cargadaEn: number;
  campos: CampoLista[];
  porId: Map<string, TareaClickUp>;
  candidatos: LeadCandidato[];
}

type EstadoEscritura = 'escrita' | 'simulada' | 'no_vivo' | 'error';

// La siguiente llamada: la más antigua que toca, sin otra anterior del mismo teléfono todavía por procesar.
const SIGUIENTE = `
  UPDATE captacion_cola q
     SET estado = 'procesando', intentos = q.intentos + 1, proximo_intento = now() + make_interval(mins => $1), actualizado_en = now()
   WHERE q.llamada_id = (
     SELECT q1.llamada_id
       FROM captacion_cola q1
       LEFT JOIN netelip_calls c1 ON c1.id = q1.llamada_id::bigint
      WHERE q1.estado IN ('pendiente', 'procesando') AND q1.proximo_intento <= now()
        AND NOT EXISTS (
          SELECT 1 FROM captacion_cola q2 JOIN netelip_calls c2 ON c2.id = q2.llamada_id::bigint
           WHERE q2.estado IN ('pendiente', 'procesando') AND q2.llamada_id <> q1.llamada_id
             AND c1.phone_e164 IS NOT NULL AND c2.phone_e164 = c1.phone_e164
             AND (q2.ocurrida_en, q2.llamada_id) < (q1.ocurrida_en, q1.llamada_id))
      ORDER BY q1.ocurrida_en, q1.llamada_id
      LIMIT 1 FOR UPDATE OF q1 SKIP LOCKED)
  RETURNING q.llamada_id, q.intentos, q.sin_lead_veces`;

const conDb = async <T>(pool: Pool, fn: (db: Db) => Promise<T>): Promise<T> => {
  const conexion = await pool.connect();
  try {
    return await fn(conexion as unknown as Db);
  } finally {
    conexion.release();
  }
};

export class ProcesadorCola {
  private instantanea: Instantanea | null = null;

  constructor(private readonly d: DependenciasCola) {}

  private ahora = (): number => (this.d.ahora ? this.d.ahora() : Date.now());
  private log = (m: string): void => (this.d.registro ?? (() => undefined))(m);

  /** Los leads de la lista de ClickUp, con una vigencia corta para no leer 2.000 tarjetas por cada llamada. */
  private async leads(): Promise<Instantanea> {
    const vigencia = this.d.vigenciaLeadsMs ?? VIGENCIA_LEADS_MS;
    if (this.instantanea && this.ahora() - this.instantanea.cargadaEn < vigencia) return this.instantanea;
    const campos = await this.d.cliente.campos();
    const tareas: TareaClickUp[] = [];
    for await (const t of this.d.cliente.tareas()) if (t.esPadre) tareas.push(t);
    const vivos = tareas.filter(esVivo);
    // Igual que el lote: el alcance provisional y el rango del formulario son datos de la tarjeta; repetirlos no duplica.
    await sembrarAlcanceProvisional(this.d.pool, vivos);
    await sembrarPresupuestoFormulario(this.d.pool, vivos);
    this.instantanea = { cargadaEn: this.ahora(), campos, porId: new Map(tareas.map((t) => [t.id, t])), candidatos: vivos.map(aLeadCandidato) };
    this.log(`ClickUp: ${tareas.length} leads, ${vivos.length} vivos`);
    return this.instantanea;
  }

  /** Procesa la siguiente llamada de la cola. null si no hay ninguna que toque. */
  async procesarSiguiente(): Promise<SalidaCola | null> {
    const { rows } = await this.d.pool.query<Reclamada>(SIGUIENTE, [RESERVA_MINUTOS]);
    const fila = rows[0];
    if (!fila) return null;
    try {
      return await this.procesar(fila);
    } catch (e) {
      return this.fallar(fila, (e as Error).message);
    }
  }

  private async procesar(fila: Reclamada): Promise<SalidaCola> {
    let inst: Instantanea;
    try {
      inst = await this.leads();
    } catch (e) {
      // ClickUp no contesta: no es culpa de la llamada, no gasta intento.
      await this.d.pool.query(
        `UPDATE captacion_cola SET estado = 'pendiente', intentos = GREATEST(intentos - 1, 0), proximo_intento = now() + make_interval(mins => $2), motivo = $3, actualizado_en = now() WHERE llamada_id = $1`,
        [fila.llamada_id, ESPERA_CLICKUP_MINUTOS, `ClickUp no disponible: ${(e as Error).message.slice(0, 300)}`],
      );
      this.log(`ClickUp no disponible (${(e as Error).message.slice(0, 120)}): se vuelve a intentar en ${ESPERA_CLICKUP_MINUTOS} min`);
      return 'esperando_clickup';
    }

    const { rows } = await this.d.pool.query<FilaLlamada>(
      `SELECT c.id::text AS id, c.occurred_at, c.direction, c.phone_e164, c.duration_seconds, t.text, t.segments
       FROM netelip_calls c LEFT JOIN netelip_call_transcriptions t ON t.call_id = c.id AND t.status = 'completed'
       WHERE c.id = $1::bigint`,
      [fila.llamada_id],
    );
    const l = rows[0];
    if (!l || l.text === null) return this.cerrar(fila, 'sin_conversacion', 'la llamada o su transcripción ya no existe');

    // N-1.0: si una persona asignó esta llamada a una tarjeta a mano (el teléfono coincidía con varias), esa asignación manda.
    const asignada = await this.asignadaAMano(fila.llamada_id);
    // Asignada a una tarjeta que existe pero ya no es un lead vivo (cerrada, o en F2 o después): no se califica, y tampoco se evalúa contra OTRO lead que comparta el teléfono.
    // Una tarjeta que ya no existe en la lista no cuenta: ahí vuelve el cruce normal.
    const tareaAsignada = asignada ? inst.porId.get(asignada) : undefined;
    if (tareaAsignada && !esVivo(tareaAsignada)) {
      return this.cerrar(fila, 'sin_lead', 'la llamada está asignada a mano a un lead que ya no está vivo (cerrado o en F2 o después): no se califica');
    }
    const entrada: EntradaLlamada = {
      llamadaId: String(l.id), telefonoE164: l.phone_e164, ocurridaEn: new Date(l.occurred_at), direccion: l.direction,
      duracionSegundos: l.duration_seconds, transcripcion: transcripcionPorTurnos(l.segments, l.text ?? ''),
      leadAsignado: asignada,
    };
    const resultado: ResultadoLlamada = await evaluarLlamadaCaptacion({
      conDb: <T>(fn: (db: Db) => Promise<T>) => conDb(this.d.pool, fn),
      leads: inst.candidatos,
      nombreLead: (id) => inst.porId.get(id)?.nombre ?? null,
      evaluar: this.d.evaluar,
      etapaLead: (id) => numeroDeEtapa(inst.porId.get(id)?.campos[NOMBRES_CAMPOS.etapa]),
      reintentarDecision: true,
    }, entrada);

    switch (resultado.estado) {
      case 'modelo_fallo':
      case 'salida_invalida':
        return this.fallar(fila, resultado.error, resultado.clickupTaskId);
      case 'sin_conversacion':
        return this.cerrar(fila, 'sin_conversacion', 'la grabación no contiene conversación');
      case 'sin_lead':
        return this.sinLead(fila, resultado.motivo, asignada);
      case 'procesada': {
        // N-1.0: una asignación a mano hecha MIENTRAS se evaluaba (no la que ya había al empezar), a otra tarjeta, no se pisa escribiendo en la que se evaluó: la llamada pasa a la
        // cola de errores con aviso, para revisarla (la evaluación ya quedó guardada sobre la tarjeta equivocada).
        const manual = await this.asignadaAMano(fila.llamada_id);
        if (manual && manual !== asignada && manual !== resultado.clickupTaskId) {
          const detalle = 'la llamada se asignó a mano a otra tarjeta mientras se evaluaba; revisar';
          await this.d.pool.query(
            `UPDATE captacion_cola SET estado = 'error', motivo = $2, clickup_task_id = $3, actualizado_en = now() WHERE llamada_id = $1`, [fila.llamada_id, detalle, resultado.clickupTaskId],
          );
          await this.d.avisar?.('Captación: llamada asignada a mano durante su evaluación', { llamada_id: fila.llamada_id }).catch(() => undefined);
          return 'error';
        }
        const e = await this.escribirEnClickUp(inst, resultado.clickupTaskId, resultado.escrituras);
        await this.d.pool.query(
          `UPDATE captacion_cola SET estado = 'procesada', clickup_task_id = $2, motivo = NULL, escritura = $3, escritura_detalle = $4, actualizado_en = now() WHERE llamada_id = $1`,
          [fila.llamada_id, resultado.clickupTaskId, e.estado, e.detalle],
        );
        if (e.estado === 'error') this.log(`Llamada ${fila.llamada_id}: evaluada, pero no se pudo escribir en ClickUp (${e.detalle ?? ''}); se reintentará`);
        return 'procesada';
      }
    }
  }

  /** Escribe en la tarjeta lo que dejó la evaluación. Un lead que ya no está vivo no se toca; sin permiso para escribir, simulacro. */
  private async escribirEnClickUp(inst: Instantanea, leadId: string, escrituras: Parameters<typeof planEscritura>[0]): Promise<{ estado: EstadoEscritura; detalle: string | null }> {
    const tarea = inst.porId.get(leadId);
    if (!tarea || !esVivo(tarea)) return { estado: 'no_vivo', detalle: null };
    if (!this.d.escribir) return { estado: 'simulada', detalle: null };
    try {
      const plan = planEscritura(escrituras, inst.campos);
      await escribirPlan(this.d.cliente, leadId, plan);
      return { estado: 'escrita', detalle: plan.omitidos.join(', ') || null };
    } catch (e) {
      const parcial = e instanceof ClickUpEscrituraParcial;
      return { estado: 'error', detalle: `${parcial ? `escritura parcial (${e.camposEscritos}/${e.camposTotal}): ` : ''}${(e as Error).message.slice(0, 200)}` };
    }
  }

  private async cerrar(fila: Reclamada, estado: 'sin_conversacion' | 'sin_lead', motivo: string): Promise<SalidaCola> {
    await this.d.pool.query(`UPDATE captacion_cola SET estado = $2, motivo = $3, actualizado_en = now() WHERE llamada_id = $1`, [fila.llamada_id, estado, motivo.slice(0, 500)]);
    return estado;
  }

  /** La tarjeta a la que una persona asignó esta llamada a mano (N-1.0), o null. */
  private async asignadaAMano(llamadaId: string): Promise<string | null> {
    const { rows } = await this.d.pool.query<{ clickup_task_id: string }>(
      `SELECT clickup_task_id FROM captacion_llamada_lead WHERE call_id = $1::bigint AND origen = 'manual' AND estado = 'vinculada'`, [llamadaId],
    );
    return rows[0]?.clickup_task_id ?? null;
  }

  /** Sin lead: se vuelve a mirar unas horas después (el lead puede crearse tras la llamada); a la tercera queda en la cola «sin lead». */
  private async sinLead(fila: Reclamada, motivo: string, asignadaAlEmpezar: string | null): Promise<SalidaCola> {
    // N-1.0: si MIENTRAS se miraba una persona asignó (o cambió la asignación de) la llamada a mano, no se rinde ni se espera 6 horas: se vuelve a probar ya, con la asignación.
    if ((await this.asignadaAMano(fila.llamada_id)) !== asignadaAlEmpezar) {
      await this.d.pool.query(
        `UPDATE captacion_cola SET estado = 'pendiente', sin_lead_veces = 0, intentos = GREATEST(intentos - 1, 0), proximo_intento = now(), motivo = NULL, actualizado_en = now() WHERE llamada_id = $1`,
        [fila.llamada_id],
      );
      return 'reintento';
    }
    const veces = fila.sin_lead_veces + 1;
    if (veces >= MAX_VECES_SIN_LEAD) {
      await this.d.pool.query(
        `UPDATE captacion_cola SET estado = 'sin_lead', sin_lead_veces = $2, motivo = $3, actualizado_en = now() WHERE llamada_id = $1`,
        [fila.llamada_id, veces, motivo.slice(0, 500)],
      );
    } else {
      await this.d.pool.query(
        `UPDATE captacion_cola SET estado = 'pendiente', sin_lead_veces = $2, intentos = GREATEST(intentos - 1, 0), proximo_intento = now() + make_interval(hours => $4), motivo = $3, actualizado_en = now() WHERE llamada_id = $1`,
        [fila.llamada_id, veces, motivo.slice(0, 500), ESPERA_SIN_LEAD_HORAS],
      );
    }
    return 'sin_lead';
  }

  /** Fallo del modelo o de la salida: reintenta con espera creciente y, al tercero, pasa a la cola de errores y avisa a tecnología. */
  private async fallar(fila: Reclamada, error: string, clickupTaskId?: string): Promise<SalidaCola> {
    const motivo = error.slice(0, 500);
    if (fila.intentos >= MAX_INTENTOS_COLA) {
      await this.d.pool.query(
        `UPDATE captacion_cola SET estado = 'error', motivo = $2, clickup_task_id = COALESCE($3, clickup_task_id), actualizado_en = now() WHERE llamada_id = $1`,
        [fila.llamada_id, motivo, clickupTaskId ?? null],
      );
      await this.d.avisar?.('Captación: llamada sin evaluar', { llamada_id: fila.llamada_id, intentos: fila.intentos, error: motivo.slice(0, 300) }).catch(() => undefined);
      return 'error';
    }
    const espera = ESPERA_REINTENTO_SEGUNDOS[Math.min(fila.intentos - 1, ESPERA_REINTENTO_SEGUNDOS.length - 1)]!;
    await this.d.pool.query(
      `UPDATE captacion_cola SET estado = 'pendiente', motivo = $2, proximo_intento = now() + make_interval(secs => $3), actualizado_en = now() WHERE llamada_id = $1`,
      [fila.llamada_id, motivo, espera],
    );
    return 'reintento';
  }

  /**
   * Procesa llamadas hasta vaciar la cola. Con un cerrojo de sesión: si otro proceso ya está procesando, no hace nada (así nunca
   * hay dos llamadas a la vez ni dos del mismo lead). Devuelve cuántas llamadas procesó.
   */
  async vaciar(): Promise<number> {
    const conexion = await this.d.pool.connect();
    try {
      const { rows } = await conexion.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, 1) AS ok', [CERROJO_COLA]);
      if (!rows[0]?.ok) return 0;
      try {
        let n = 0;
        for (;;) {
          const r = await this.procesarSiguiente();
          if (r === null || r === 'esperando_clickup') break;
          n += 1;
        }
        return n;
      } finally {
        await conexion.query('SELECT pg_advisory_unlock($1, 1)', [CERROJO_COLA]);
      }
    } finally {
      conexion.release();
    }
  }

  /**
   * Las llamadas ya evaluadas cuya escritura en ClickUp falló: se vuelve a calcular el estado del lead con lo guardado (sin llamar al
   * modelo) y se escribe. Solo las de los últimos dos días, cada 15 minutos como mucho, de 20 en 20.
   */
  async reescribirPendientes(): Promise<number> {
    const { rows } = await this.d.pool.query<{ clickup_task_id: string }>(
      `SELECT DISTINCT clickup_task_id FROM captacion_cola
       WHERE escritura = 'error' AND estado = 'procesada' AND clickup_task_id IS NOT NULL
         AND creado_en > now() - interval '2 days' AND actualizado_en < now() - interval '15 minutes'
       LIMIT 20`,
    );
    if (rows.length === 0) return 0;
    let inst: Instantanea;
    try {
      inst = await this.leads();
    } catch {
      return 0;
    }
    let escritos = 0;
    for (const { clickup_task_id: leadId } of rows) {
      const r = await conDb(this.d.pool, (db) => enTransaccion(db, async () => {
        await bloquearLead(db, leadId);
        return recalcularLead(db, leadId, { disparador: 'recalculo' });
      }));
      const e = await this.escribirEnClickUp(inst, leadId, r.escrituras);
      await this.d.pool.query(
        `UPDATE captacion_cola SET escritura = $2, escritura_detalle = $3, actualizado_en = now() WHERE clickup_task_id = $1 AND escritura = 'error'`,
        [leadId, e.estado, e.detalle],
      );
      if (e.estado !== 'error') escritos += 1;
    }
    return escritos;
  }
}
