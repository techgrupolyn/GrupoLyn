// Evaluación de las reuniones de Meet de los closers con la rúbrica de su fase (869fppbcj, bloque C).
//
//   encolarReuniones            reunion `por_evaluar` → fila `pendiente` en llamada_evaluacion (reunion_id + rubrica_version_id)
//   procesarSiguienteReunion    la evalúa con Gemini, igual que una llamada, y guarda nota, pasos, errores y objeciones
//
// Reutiliza el calificador de llamadas de Juan: prompt y esquema de la rúbrica versionada, validación de la salida,
// citas verificadas y la decisión de apto / escalado (decidir). Lo propio de las reuniones:
//   - la transcripción de Meet se convierte a turnos GRUPO LYN / CLIENTE y se enmascara (transcripcion.ts);
//   - sin hablantes identificados, la evaluación queda «con duda» (el modelo no sabe quién dijo qué);
//   - no hay feedback por WhatsApp (enviarPendientes solo envía llamadas);
//   - las objeciones se guardan con evaluacion_id y llamada_id NULL.
// La cola de llamadas ignora estas filas (llamada_id IS NOT NULL) y esta, las de llamadas (reunion_id IS NOT NULL).
import type { Pool } from 'pg';
import { notifyTech } from '../netelip/processing.ts';
import { esquemaSalida, promptSistemaVersionado, type Evaluador } from '../netelip/calificador/modelo.ts';
import { decidir, SalidaInvalida, validarSalida, type Decision } from '../netelip/calificador/reglas.ts';
import { rubricaPorId } from '../netelip/calificador/rubrica.ts';
import { niegaGrabacion } from './reglas.ts';
import { prepararTranscripcion } from './transcripcion.ts';

type Consultable = Pick<Pool, 'query'>;

export const MAX_INTENTOS = 3;
const BACKOFF_SEGUNDOS = [60, 300, 900];
/** Una reunión de 60 min ronda 50.000–80.000 caracteres. Por encima de esto no se envía (coste y límite del modelo). */
export const MAX_CARACTERES_DEFECTO = 150_000;

export type ConfigReuniones = { supervisorNombre: string; maxCaracteres: number };

export function configReunionesDesdeEnv(env: NodeJS.ProcessEnv = process.env): ConfigReuniones {
  const max = Number(env.REUNIONES_MEET_MAX_CARACTERES);
  return {
    supervisorNombre: env.CALIFICADOR_SUPERVISOR_NOMBRE?.trim() || 'Ernesto',
    maxCaracteres: Number.isSafeInteger(max) && max >= 10_000 ? max : MAX_CARACTERES_DEFECTO,
  };
}

/**
 * Crea la evaluación `pendiente` de cada reunión `por_evaluar`, con la versión de rúbrica que encontró la vinculación.
 * Idempotente: no crea otra si la reunión ya tiene una evaluación con esa versión (y el índice único
 * llamada_evaluacion_reunion_rubrica lo impide de todos modos).
 */
export async function encolarReuniones(pool: Consultable, lote = 50): Promise<number> {
  const { rowCount } = await pool.query(
    `INSERT INTO llamada_evaluacion (reunion_id, empleado_id, rol, rubrica_version_id, version_rubrica, estado)
     SELECT r.id, r.empleado_id, r.rol, r.rubrica_version_id::bigint, r.version_rubrica, 'pendiente'
     FROM reunion r
     WHERE r.estado = 'por_evaluar' AND r.rubrica_version_id ~ '^[0-9]+$'
       AND NOT EXISTS (SELECT 1 FROM llamada_evaluacion e WHERE e.reunion_id = r.id AND e.rubrica_version_id = r.rubrica_version_id::bigint)
     ORDER BY r.id LIMIT $1
     ON CONFLICT DO NOTHING`,
    [lote],
  );
  return rowCount || 0;
}

/** Contexto que acompaña a la transcripción. Sin datos del cliente: solo rol, fase y duración. */
export function promptUsuarioReunion(args: { rol: string | null; fase: string | null; duracionSegundos: number | null; conHablantes: boolean; transcripcion: string }): string {
  const min = args.duracionSegundos ? `${Math.max(1, Math.round(args.duracionSegundos / 60))} min` : 'duración desconocida';
  const voces = args.conHablantes ? '' : ' · hablantes sin identificar';
  return `Contexto: rol ${args.rol || 'closer'} · reunión de Meet${args.fase ? ` de ${args.fase}` : ''} · ${min}${voces} · presupuesto_registrado: no\n\nTranscripción:\n${args.transcripcion}`;
}

/** Sin hablantes, la decisión se marca con duda y se escala: el modelo no sabe quién dijo qué. */
export function conDudaSinHablantes(d: Decision): Decision {
  const motivo = 'Meet no identificó a los hablantes: no se sabe qué dijo el comercial y qué el cliente';
  if (d.duda) return d;
  return { ...d, duda: true, motivo_duda: motivo, escalado: true, motivo_escalado: [d.motivo_escalado, `duda: ${motivo}`].filter(Boolean).join('; ') };
}

type Trabajo = {
  id: string; reunion_id: string; intentos: number; rol: string | null; rubrica_version_id: string | null; reevaluacion: boolean;
  titulo: string; fase: string | null; duracion_segundos: number | null; content_text: string | null; reunion_estado: string;
  sin_consentimiento_previo: boolean;
};

async function cerrar(pool: Consultable, job: Trabajo, estadoReunion: 'no_evaluada' | 'sin_consentimiento' | 'error', motivo: string, sinConsentimiento = false): Promise<string> {
  await pool.query(
    `UPDATE llamada_evaluacion SET estado = 'no_evaluada', motivo_no_evaluada = $2, sin_consentimiento = sin_consentimiento OR $3, actualizado_en = NOW() WHERE id = $1`,
    [job.id, motivo.slice(0, 500), sinConsentimiento],
  );
  if (sinConsentimiento) await pool.query('DELETE FROM objecion_marketing WHERE evaluacion_id = $1', [job.id]);
  // Una reevaluación que no sale no cambia el estado de la reunión, salvo la negativa a grabar (es definitiva).
  if (!job.reevaluacion || sinConsentimiento) {
    await pool.query(`UPDATE reunion SET estado = $2, motivo = $3, actualizado_en = NOW() WHERE id = $1`, [job.reunion_id, estadoReunion, motivo.slice(0, 500)]);
  }
  return estadoReunion;
}

/** Nombres y emails de los empleados activos: quien coincide habla por GRUPO LYN en la transcripción. */
async function equipoLyn(pool: Consultable): Promise<string[]> {
  // to_jsonb: no todas las bases tienen `apellido` (las de prueba no), y así no falla por una columna.
  const { rows } = await pool.query<{ e: Record<string, unknown> }>(`SELECT to_jsonb(e) AS e FROM empleados e WHERE e.activo`);
  return rows.flatMap(({ e }) => [[e.nombre, e.apellido].filter(Boolean).join(' '), String(e.email || '')]).filter((x) => String(x).trim());
}

/** Evalúa la siguiente reunión de la cola. Devuelve el resultado o null si no hay trabajo. */
export async function procesarSiguienteReunion(pool: Consultable, evaluar: Evaluador, config: ConfigReuniones): Promise<string | null> {
  const { rows } = await pool.query<Trabajo>(
    `UPDATE llamada_evaluacion e SET estado = 'procesando', intentos = e.intentos + 1, proximo_intento = NOW() + INTERVAL '10 minutes', actualizado_en = NOW()
     FROM reunion r JOIN google_drive_artifacts a ON a.id = r.artifact_id
     WHERE r.id = e.reunion_id AND e.id = (
       SELECT id FROM llamada_evaluacion WHERE estado IN ('pendiente','procesando') AND proximo_intento <= NOW() AND reunion_id IS NOT NULL
       ORDER BY proximo_intento LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING e.id, e.reunion_id, e.intentos, e.rol, e.rubrica_version_id, e.reevaluacion,
       r.titulo, r.fase, r.duracion_segundos, a.content_text, r.estado AS reunion_estado,
       EXISTS (SELECT 1 FROM llamada_evaluacion x WHERE x.reunion_id = e.reunion_id AND x.sin_consentimiento) AS sin_consentimiento_previo`,
  );
  if (!rows.length) return null;
  const job = rows[0];
  const negativa = 'Un participante se niega a que se grabe la reunión.';
  // La negativa es definitiva: tampoco entra en una reevaluación.
  if (job.reunion_estado === 'sin_consentimiento' || job.sin_consentimiento_previo || niegaGrabacion(job.content_text)) {
    return cerrar(pool, job, 'sin_consentimiento', negativa, true);
  }
  if ((job.content_text || '').length > config.maxCaracteres) {
    return cerrar(pool, job, 'no_evaluada', `Transcripción demasiado larga (${(job.content_text || '').length} caracteres; máximo ${config.maxCaracteres}).`);
  }
  const rubrica = job.rubrica_version_id ? await rubricaPorId(pool as Pool, job.rubrica_version_id) : null;
  if (!rubrica) return cerrar(pool, job, 'error', `No existe la rúbrica ${job.rubrica_version_id ?? '(sin versión)'}.`);

  const preparada = prepararTranscripcion(job.content_text, await equipoLyn(pool));
  if (!preparada.transcripcion.trim()) return cerrar(pool, job, 'no_evaluada', 'La transcripción no contiene conversación.');

  let respuesta;
  let salida;
  try {
    const usuario = promptUsuarioReunion({ rol: job.rol, fase: job.fase, duracionSegundos: job.duracion_segundos ?? preparada.duracionSegundos, conHablantes: preparada.conHablantes, transcripcion: preparada.transcripcion });
    respuesta = await evaluar(promptSistemaVersionado(rubrica), usuario, esquemaSalida(rubrica));
    salida = validarSalida(respuesta.text, rubrica);
  } catch (error) {
    const message = (error as Error).message.slice(0, 500);
    const final = job.intentos >= MAX_INTENTOS;
    console.error(JSON.stringify({ msg: 'reuniones_meet_fallo_modelo', evaluacion_id: job.id, reunion_id: job.reunion_id, intento: job.intentos, final, invalida: error instanceof SalidaInvalida, error: message }));
    if (final) {
      await notifyTech('Calificador: reunión de Meet sin evaluar', { evaluacion_id: job.id, reunion_id: job.reunion_id, error: message });
      return cerrar(pool, job, 'error', `El modelo falló ${MAX_INTENTOS} veces: ${message}`);
    }
    const delay = BACKOFF_SEGUNDOS[Math.min(job.intentos - 1, BACKOFF_SEGUNDOS.length - 1)];
    await pool.query(`UPDATE llamada_evaluacion SET estado = 'pendiente', proximo_intento = NOW() + make_interval(secs => $2), actualizado_en = NOW() WHERE id = $1`, [job.id, delay]);
    return 'reintento';
  }
  if (!salida.llamada_evaluable) return cerrar(pool, job, 'no_evaluada', `No evaluable: ${salida.motivo_no_evaluable}`);

  let d = decidir(salida, preparada.transcripcion, {
    presupuestoRegistrado: false, supervisor: config.supervisorNombre,
    notaApto: rubrica.nota_apto, nombresReglas: Object.fromEntries(rubrica.errores_criticos.map((e) => [e.codigo, e.nombre])),
  });
  if (!preparada.conHablantes) d = conDudaSinHablantes(d);

  // Una conexión propia para la transacción: con un pg.Pool, cada query podría ir por una conexión distinta y el
  // BEGIN no protegería nada. En los tests llega un pg.Client ya conectado, que sirve tal cual.
  const esPool = typeof (pool as Pool).totalCount === 'number';
  const conexion = esPool ? await (pool as Pool).connect() : null;
  const tx: Consultable = conexion ?? pool;
  await tx.query('BEGIN');
  try {
    await tx.query(
      `UPDATE llamada_evaluacion SET estado = 'evaluada', motivo_no_evaluada = NULL, nota = $2, apto = $3, errores_criticos = $4, errores_descartados = $5,
         bien = $6, mejorar = $7, escalado = $8, motivo_escalado = $9, duda = $10, motivo_duda = $11, feedback_texto = NULL,
         version_rubrica = $12, modelo = $13, tokens_entrada = $14, tokens_salida = $15, puntuacion_pasos = $16, actualizado_en = NOW()
       WHERE id = $1`,
      [job.id, salida.nota, d.apto, JSON.stringify(d.errores_criticos), JSON.stringify(d.errores_descartados), salida.bien, JSON.stringify(salida.mejorar),
        d.escalado, d.motivo_escalado, d.duda, d.motivo_duda, rubrica.codigo, respuesta.model, respuesta.inputTokens, respuesta.outputTokens,
        salida.pasos ? JSON.stringify(salida.pasos) : null],
    );
    await tx.query('DELETE FROM objecion_marketing WHERE evaluacion_id = $1', [job.id]);
    for (const o of d.objeciones) {
      await tx.query('INSERT INTO objecion_marketing (llamada_id, evaluacion_id, tipo_objecion, cita, idea_contenido) VALUES (NULL, $1, $2, $3, $4)',
        [job.id, o.tipo, o.cita, o.idea_contenido]);
    }
    await tx.query(`UPDATE reunion SET estado = 'evaluada', motivo = NULL, actualizado_en = NOW() WHERE id = $1`, [job.reunion_id]);
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { conexion?.release(); }
  console.log(JSON.stringify({ msg: 'reuniones_meet_evaluada', evaluacion_id: job.id, reunion_id: job.reunion_id, rubrica: rubrica.codigo, reevaluacion: job.reevaluacion,
    nota: salida.nota, apto: d.apto, escalado: d.escalado, duda: d.duda, criticos: d.errores_criticos.length, objeciones: d.objeciones.length, tokens: [respuesta.inputTokens, respuesta.outputTokens] }));
  return 'evaluada';
}
