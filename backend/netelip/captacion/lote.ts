// Lote de captación ABCD: procesa las llamadas ya transcritas de una ventana de fechas contra los leads de
// ClickUp y entrega una tabla lead / letra / frases citadas. Sirve para la primera entrega (leads existentes) y
// para repasar una semana. Por defecto es un SIMULACRO: guarda la evaluación en las tablas de la captación (usa una
// copia de la base, nunca la de producción) pero no escribe nada en ClickUp. Escribir exige un tope explícito.
import type { Pool } from 'pg';
import type { Evaluador } from '../calificador/modelo.ts';
import { DURACION_MINIMA_SEGUNDOS, transcripcionPorTurnos, type Segmento } from '../calificador/reglas.ts';
import { nivelAlcanceProvisional } from './agregacion.ts';
import {
  aLeadCandidato, ClickUpConfigError, ClickUpEscrituraParcial, escribirPlan, NOMBRES_CAMPOS, planEscritura,
  type CampoLista, type ClickUpClient, type TareaClickUp,
} from './clickup.ts';
import { evaluarLlamadaCaptacion, interaccionDe, type EntradaLlamada, type ResultadoLlamada } from './proceso.ts';
import { registrarAlcanceProvisional, registrarPresupuestoFormulario, type Db } from './repositorio.ts';
import type { LeadCandidato } from './vinculacion.ts';

/** Última etapa en la que un lead sigue vivo. Las finales son e14 GANADO, e15 PERDIDO, e16 RECHAZADO y e18 PASE. */
export const ETAPA_VIVA_MAX = 13;

/** Número de una etapa de ClickUp: «e3. VIABILIDAD» → 3. Null si el nombre no empieza por «e» y un número. */
const numeroDeEtapa = (etapa: unknown): number | null => {
  const m = /^e(\d+)/i.exec(String(etapa ?? '').trim());
  return m ? Number(m[1]) : null;
};

/** Un lead está «vivo» si su tarea no está cerrada y su etapa va de e1 a e13 (los nombres reales: «e3. VIABILIDAD»). */
export const esVivo = (t: TareaClickUp): boolean => {
  const n = numeroDeEtapa(t.campos[NOMBRES_CAMPOS.etapa]);
  return !t.cerrada && n !== null && n >= 1 && n <= ETAPA_VIVA_MAX;
};

export interface OpcionesLote {
  pool: Pool;
  cliente: ClickUpClient;
  evaluar: Evaluador;
  desde: Date;
  hasta: Date;
  /**
   * Leads entre los que se busca a quién pertenece cada llamada. `vivos` (por defecto) resuelve de paso los
   * teléfonos repetidos cuando solo una de las tareas sigue viva; `todos` aplica la regla del ticket tal cual.
   */
  candidatos?: 'vivos' | 'todos';
  /** Máximo de leads en los que escribir. 0 (por defecto) = simulacro: no se escribe nada en ClickUp. */
  escribirMaximo?: number;
  /** Máximo de llamadas a procesar (para una prueba corta). */
  limite?: number;
  /** Intentos por llamada si el modelo falla o contesta mal. Por defecto 2. */
  intentos?: number;
  esperar?: (ms: number) => Promise<void>;
  registro?: (mensaje: string) => void;
}

export interface CitaLote { criterio: string; nivel: string; cita: string }

export interface FilaLote {
  llamadaId: string;
  ocurridaEn: string;
  duracionSegundos: number;
  lead: { id: string; nombre: string; etapa: string | null } | null;
  via: 'telefono' | 'email' | null;
  estado: ResultadoLlamada['estado'] | 'error';
  motivo: string | null;
  categoria: string | null;
  desglose: string | null;
  citas: CitaLote[];
  descartes: number;
  revisionManual: string[];
  intentos: number;
}

export interface EscrituraLote {
  clickupTaskId: string;
  nombre: string;
  /** `no_vivo`: el lead ya no está en una etapa viva (e1 a e13): nunca se escribe en él y no consume cupo. */
  resultado: 'escrito' | 'simulado' | 'sin_cupo' | 'no_vivo' | 'error';
  campos: number;
  detalle: string | null;
}

export interface InformeLote {
  filas: FilaLote[];
  escrituras: EscrituraLote[];
  resumen: {
    leadsEnLista: number;
    leadsVivos: number;
    alcanceProvisional: number;
    /** Leads cuyo rango de «Presupuesto formulario» se registró como presupuesto del cliente en esta pasada. */
    presupuestoFormulario: number;
    llamadas: number;
    porEstado: Record<string, number>;
    leadsCalificados: number;
    porCategoria: Record<string, number>;
  };
}

const dormir = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const conDb = async <T>(pool: Pool, fn: (db: Db) => Promise<T>): Promise<T> => {
  const conexion = await pool.connect();
  try {
    return await fn(conexion);
  } finally {
    conexion.release();
  }
};

interface FilaLlamadaSql {
  id: string; occurred_at: Date; direction: string; phone_e164: string | null; duration_seconds: number;
  text: string | null; segments: Segmento[] | null;
}

/** Llamadas con transcripción completa de la ventana, por orden de fecha (la categoría final es la de la última). */
export async function llamadasDeLaVentana(pool: Pool, desde: Date, hasta: Date, limite?: number): Promise<FilaLlamadaSql[]> {
  const { rows } = await pool.query<FilaLlamadaSql>(
    `SELECT c.id, c.occurred_at, c.direction, c.phone_e164, c.duration_seconds, t.text, t.segments
     FROM netelip_calls c
     JOIN netelip_call_transcriptions t ON t.call_id = c.id AND t.status = 'completed'
     WHERE c.occurred_at >= $1 AND c.occurred_at < $2 AND c.duration_seconds >= $3
     ORDER BY c.occurred_at, c.id
     LIMIT $4`,
    [desde, hasta, DURACION_MINIMA_SEGUNDOS, limite ?? 100_000],
  );
  return rows;
}

/** Deja el nivel provisional de Alcance (del formulario) de cada lead que lo permita. Repetirlo no duplica. */
export async function sembrarAlcanceProvisional(pool: Pool, tareas: readonly TareaClickUp[]): Promise<number> {
  let nuevos = 0;
  await conDb(pool, async (db) => {
    for (const t of tareas) {
      const nivel = nivelAlcanceProvisional({
        tipoReforma: t.campos[NOMBRES_CAMPOS.tipo_reforma] as string | null,
        tipoContacto: t.campos[NOMBRES_CAMPOS.tipo_contacto] as string | null,
      });
      const fecha = new Date(t.creadaEn || 0).toISOString();
      if (await registrarAlcanceProvisional(db, { clickupTaskId: t.id, nivel, fechaInteraccion: fecha })) nuevos += 1;
    }
  });
  return nuevos;
}

/**
 * Registra como presupuesto del cliente el rango que marcó en el formulario web («Presupuesto formulario»). La fecha es la
 * de creación de la tarjeta: una llamada posterior en la que el cliente diga un importe lo sustituye. Repetirlo no duplica.
 * Solo deja el dato: no califica ni escribe a nadie (un lead sin llamada sigue sin letra).
 */
export async function sembrarPresupuestoFormulario(pool: Pool, tareas: readonly TareaClickUp[]): Promise<number> {
  let nuevos = 0;
  await conDb(pool, async (db) => {
    for (const t of tareas) {
      const opcion = t.campos[NOMBRES_CAMPOS.presupuesto_formulario];
      if (typeof opcion !== 'string') continue;
      const fecha = new Date(t.creadaEn || 0).toISOString();
      if (await registrarPresupuestoFormulario(db, { clickupTaskId: t.id, opcion, fechaInteraccion: fecha })) nuevos += 1;
    }
  });
  return nuevos;
}

async function citasDe(pool: Pool, interaccionId: string): Promise<CitaLote[]> {
  const { rows } = await pool.query<{ criterio_id: string; nivel: string; cita: string }>(
    `SELECT criterio_id, nivel, cita FROM lead_criterio_evaluacion
     WHERE interaccion_id = $1 AND nivel <> 'NE' ORDER BY criterio_id`,
    [interaccionId],
  );
  return rows.map((r) => ({ criterio: r.criterio_id, nivel: r.nivel, cita: r.cita }));
}

export async function ejecutarLote(o: OpcionesLote): Promise<InformeLote> {
  const registro = o.registro ?? (() => undefined);
  const esperar = o.esperar ?? dormir;
  const intentosMax = Math.max(1, o.intentos ?? 2);
  const cupo = o.escribirMaximo ?? 0;
  // Un tope que no sea un entero normal (negativo, decimal, infinito, NaN) nunca debe poder dejar escribir de más.
  if (!Number.isSafeInteger(cupo) || cupo < 0) throw new Error('escribirMaximo debe ser un entero de 0 o más');

  const campos: CampoLista[] = await o.cliente.campos();
  const tareas: TareaClickUp[] = [];
  for await (const t of o.cliente.tareas()) if (t.esPadre) tareas.push(t);
  const porId = new Map(tareas.map((t) => [t.id, t]));
  const vivos = tareas.filter(esVivo);
  registro(`ClickUp: ${tareas.length} leads, ${vivos.length} vivos`);

  const alcanceProvisional = await sembrarAlcanceProvisional(o.pool, vivos);
  const presupuestoFormulario = await sembrarPresupuestoFormulario(o.pool, vivos);
  const candidatos: LeadCandidato[] = (o.candidatos === 'todos' ? tareas : vivos).map(aLeadCandidato);

  const ultima = new Map<string, Extract<ResultadoLlamada, { estado: 'procesada' }>>();
  const filas: FilaLote[] = [];
  const llamadas = await llamadasDeLaVentana(o.pool, o.desde, o.hasta, o.limite);
  registro(`Llamadas con transcripción en la ventana: ${llamadas.length}`);

  for (const [i, l] of llamadas.entries()) {
    const entrada: EntradaLlamada = {
      llamadaId: String(l.id), telefonoE164: l.phone_e164, ocurridaEn: new Date(l.occurred_at), direccion: l.direction,
      duracionSegundos: l.duration_seconds, transcripcion: transcripcionPorTurnos(l.segments, l.text ?? ''),
    };
    const deps = {
      conDb: <T>(fn: (db: Db) => Promise<T>) => conDb(o.pool, fn),
      leads: candidatos,
      nombreLead: (id: string) => porId.get(id)?.nombre ?? null,
      evaluar: o.evaluar,
    };
    let resultado: ResultadoLlamada | null = null;
    let error: string | null = null;
    let intentos = 0;
    for (; intentos < intentosMax; ) {
      intentos += 1;
      try {
        resultado = await evaluarLlamadaCaptacion(deps, entrada);
        error = null;
      } catch (e) {
        resultado = null;
        error = (e as Error).message.slice(0, 300);
      }
      const reintentable = error !== null || resultado?.estado === 'modelo_fallo' || resultado?.estado === 'salida_invalida';
      if (!reintentable || intentos >= intentosMax) break;
      await esperar(2000);
    }

    const base = { llamadaId: entrada.llamadaId, ocurridaEn: entrada.ocurridaEn.toISOString(), duracionSegundos: entrada.duracionSegundos, intentos };
    if (resultado === null) {
      filas.push({ ...base, lead: null, via: null, estado: 'error', motivo: error, categoria: null, desglose: null, citas: [], descartes: 0, revisionManual: [] });
    } else if (resultado.estado === 'procesada') {
      const t = porId.get(resultado.clickupTaskId);
      ultima.set(resultado.clickupTaskId, resultado);
      filas.push({
        ...base, lead: { id: resultado.clickupTaskId, nombre: t?.nombre ?? '', etapa: (t?.campos[NOMBRES_CAMPOS.etapa] as string | null) ?? null },
        via: resultado.via, estado: 'procesada', motivo: null, categoria: resultado.categoria, desglose: resultado.escrituras.desglose ?? null,
        citas: await citasDe(o.pool, interaccionDe(entrada.llamadaId)), descartes: resultado.descartes.length, revisionManual: [...resultado.revisionManual],
      });
    } else {
      const lead = 'clickupTaskId' in resultado ? porId.get(resultado.clickupTaskId) : undefined;
      filas.push({
        ...base, lead: lead ? { id: lead.id, nombre: lead.nombre, etapa: (lead.campos[NOMBRES_CAMPOS.etapa] as string | null) ?? null } : null,
        via: null, estado: resultado.estado, motivo: 'motivo' in resultado ? resultado.motivo : 'error' in resultado ? resultado.error : null,
        categoria: null, desglose: null, citas: [], descartes: 0, revisionManual: [],
      });
    }
    if ((i + 1) % 10 === 0) registro(`  ${i + 1}/${llamadas.length} llamadas`);
  }

  // Escritura en ClickUp: una vez por lead, con su estado final, y solo hasta el tope indicado.
  const escrituras: EscrituraLote[] = [];
  let escritos = 0;
  for (const [id, r] of ultima) {
    const tarea = porId.get(id);
    const nombre = tarea?.nombre ?? '';
    // Aunque se haya vinculado una llamada (con «candidatos todos»), un lead que ya no está vivo no se toca en ClickUp.
    if (!tarea || !esVivo(tarea)) {
      escrituras.push({ clickupTaskId: id, nombre, resultado: 'no_vivo', campos: 0, detalle: null });
      continue;
    }
    if (cupo === 0) {
      escrituras.push({ clickupTaskId: id, nombre, resultado: 'simulado', campos: 0, detalle: null });
      continue;
    }
    if (escritos >= cupo) {
      escrituras.push({ clickupTaskId: id, nombre, resultado: 'sin_cupo', campos: 0, detalle: null });
      continue;
    }
    try {
      const plan = planEscritura(r.escrituras, campos);
      const n = await escribirPlan(o.cliente, id, plan);
      escritos += 1;
      escrituras.push({ clickupTaskId: id, nombre, resultado: 'escrito', campos: n, detalle: plan.omitidos.join(', ') || null });
    } catch (e) {
      // Una escritura a medias ya tocó la tarea: consume cupo y se informa de los campos que sí quedaron escritos.
      const parcial = e instanceof ClickUpEscrituraParcial;
      if (parcial) escritos += 1;
      escrituras.push({
        clickupTaskId: id, nombre, resultado: 'error', campos: parcial ? e.camposEscritos : 0,
        detalle: e instanceof ClickUpConfigError ? e.message : (e as Error).message.slice(0, 200),
      });
    }
  }

  const contar = <T>(xs: readonly T[], clave: (x: T) => string | null) => {
    const m: Record<string, number> = {};
    for (const x of xs) {
      const k = clave(x);
      if (k) m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  };
  return {
    filas,
    escrituras,
    resumen: {
      leadsEnLista: tareas.length,
      leadsVivos: vivos.length,
      alcanceProvisional,
      presupuestoFormulario,
      llamadas: filas.length,
      porEstado: contar(filas, (f) => f.estado),
      leadsCalificados: ultima.size,
      porCategoria: contar([...ultima.values()], (r) => r.categoria),
    },
  };
}
