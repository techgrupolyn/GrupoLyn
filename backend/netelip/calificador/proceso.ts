// Proceso del calificador: encolar al terminar la transcripción, evaluar con reintentos, guardar y
// enviar el feedback. Mismo patrón que la transcripción de Netelip: PostgreSQL + SKIP LOCKED.
import type { Pool } from 'pg';
import { notifyTech } from '../processing.ts';
import { esquemaSalida, promptSistema, promptSistemaVersionado, promptUsuario, VERSION_RUBRICA, type Evaluador } from './modelo.ts';
import {
  decidir, detectarNegativaGrabacion, enmascarar, SalidaInvalida, textoFeedback, transcripcionPorTurnos, validarSalida,
  type Segmento,
} from './reglas.ts';
import { rubricaPorId } from './rubrica.ts';
import { motivoSinRubrica, ROL_CON_RUBRICA_FIJA } from './encolar.ts';

export const MAX_INTENTOS = 3;
const BACKOFF_SEGUNDOS = [60, 300, 900];
const MAX_INTENTOS_ENVIO = 3;

/** Envía un texto por WhatsApp al número E.164. Lanza si no se pudo. */
export type Enviador = (telefonoE164: string, texto: string) => Promise<void>;

export type ConfigCalificador = {
  supervisorNombre: string;
  supervisorWhatsapp: string | null;
  dashboardUrl: string | null;
  envioActivo: boolean;
};

export function configDesdeEnv(env: NodeJS.ProcessEnv = process.env): ConfigCalificador {
  return {
    supervisorNombre: env.CALIFICADOR_SUPERVISOR_NOMBRE?.trim() || 'Ernesto',
    supervisorWhatsapp: env.CALIFICADOR_SUPERVISOR_WHATSAPP?.trim() || null,
    dashboardUrl: env.CALIFICADOR_DASHBOARD_URL?.trim() || null,
    envioActivo: env.CALIFICADOR_ENVIO === 'whatsapp',
  };
}

/** «dd/mm hh:mm» en hora de Madrid. */
const madrid = (d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day.padStart(2, '0')}/${p.month.padStart(2, '0')} ${p.hour.padStart(2, '0')}:${p.minute}`;
};

// --- Evaluar ----------------------------------------------------------------------------------

type Trabajo = {
  id: string; llamada_id: string; intentos: number; rol: string; extension_netelip: string;
  rubrica_version_id: string | null; reevaluacion: boolean; sin_consentimiento_previo: boolean;
  direction: string; duration_seconds: number; occurred_at: Date;
  t_status: string | null; t_text: string | null; segments: Segmento[] | null;
  lead_name: string | null; client_name: string | null; client_addresses?: string[] | null;
};

async function noEvaluada(pool: Pool, id: string, motivo: string): Promise<'no_evaluada'> {
  await pool.query(`UPDATE llamada_evaluacion SET estado = 'no_evaluada', motivo_no_evaluada = $2, actualizado_en = NOW() WHERE id = $1`, [id, motivo.slice(0, 500)]);
  return 'no_evaluada';
}

/** «Sin consentimiento»: no evaluada, sin objeciones ni ideas de marketing. */
async function sinConsentimiento(pool: Pool, id: string): Promise<'sin_consentimiento'> {
  await pool.query(`UPDATE llamada_evaluacion SET estado = 'no_evaluada', sin_consentimiento = TRUE,
     motivo_no_evaluada = 'sin consentimiento: el cliente no autoriza la grabación', actualizado_en = NOW() WHERE id = $1`, [id]);
  await pool.query('DELETE FROM objecion_marketing WHERE evaluacion_id = $1', [id]);
  return 'sin_consentimiento';
}

/** Evalúa la siguiente llamada de la cola. Devuelve el resultado o null si no hay trabajo. */
export async function procesarSiguienteEvaluacion(pool: Pool, evaluar: Evaluador, config: ConfigCalificador): Promise<string | null> {
  const { rows } = await pool.query<Trabajo>(
    `UPDATE llamada_evaluacion e SET estado = 'procesando', intentos = e.intentos + 1, proximo_intento = NOW() + INTERVAL '10 minutes', actualizado_en = NOW()
     FROM netelip_calls c
     LEFT JOIN netelip_call_transcriptions t ON t.call_id = c.id
     LEFT JOIN crm_leads l ON l.id = c.lead_id
     LEFT JOIN clientes cl ON cl.id = c.client_id
     WHERE c.id = e.llamada_id AND e.id = (
       -- llamada_id IS NOT NULL: las evaluaciones de reuniones de Meet (869fppbcj) tienen su propio procesador; sin el
       -- filtro, una reunión pendiente sería la «más antigua», el cruce con netelip_calls no la encontraría y la cola se pararía.
       SELECT id FROM llamada_evaluacion WHERE estado IN ('pendiente','procesando') AND proximo_intento <= NOW() AND llamada_id IS NOT NULL
       ORDER BY proximo_intento LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING e.id, e.llamada_id, e.intentos, e.rol, e.extension_netelip, e.rubrica_version_id, e.reevaluacion,
       EXISTS (SELECT 1 FROM llamada_evaluacion x WHERE x.llamada_id = e.llamada_id AND x.sin_consentimiento) AS sin_consentimiento_previo,
       c.direction, c.duration_seconds, c.occurred_at,
       t.status AS t_status, t.text AS t_text, t.segments, l.name AS lead_name, CONCAT_WS(' ', cl.nombre, cl.apellido) AS client_name,
       -- crm_leads y clientes no guardan dirección: la que hay es la de las obras del cliente (proyectos.direccion).
       ARRAY(SELECT p.direccion FROM proyectos p WHERE p.cliente_id = COALESCE(c.client_id, l.client_id) AND NULLIF(TRIM(p.direccion), '') IS NOT NULL) AS client_addresses`,
  );
  if (!rows.length) return null;
  const job = rows[0];
  // Una llamada marcada «sin consentimiento» no vuelve a ir al modelo, tampoco en una reevaluación.
  if (job.sin_consentimiento_previo) return sinConsentimiento(pool, job.id);
  // CAL-06: fila pendiente anterior al cambio de un rol sin rúbrica propia. fase0-v1 es solo del SDR.
  if (!job.rubrica_version_id && job.rol !== ROL_CON_RUBRICA_FIJA) return noEvaluada(pool, job.id, motivoSinRubrica(job.rol));
  if (job.t_status === 'failed' || !job.t_status) return noEvaluada(pool, job.id, 'transcripción no disponible');
  if (job.t_status !== 'completed') {
    // Aún transcribiendo: se vuelve a mirar en un minuto sin gastar intento.
    await pool.query(`UPDATE llamada_evaluacion SET estado = 'pendiente', intentos = intentos - 1, proximo_intento = NOW() + INTERVAL '1 minute' WHERE id = $1`, [job.id]);
    return 'esperando_transcripcion';
  }
  const turnos = transcripcionPorTurnos(job.segments, job.t_text || '');
  if (!turnos.trim()) return noEvaluada(pool, job.id, 'la grabación no contiene conversación');
  const transcripcion = enmascarar(turnos, [job.lead_name || '', job.client_name || ''], job.client_addresses || []);
  // El cliente no autoriza la grabación: no se envía al modelo ni se guardan objeciones (869fpj8dm).
  if (detectarNegativaGrabacion(transcripcion)) return sinConsentimiento(pool, job.id);
  // P-05: crm_leads aún no guarda el presupuesto del lead; mientras no exista, nunca consta como registrado.
  const presupuestoRegistrado = false;
  // Rúbrica versionada de la fila (la activa al encolar, o la pedida en una reevaluación); sin ella, fase0-v1 (SDR).
  const rubrica = job.rubrica_version_id ? await rubricaPorId(pool, job.rubrica_version_id) : null;
  if (job.rubrica_version_id && !rubrica) return noEvaluada(pool, job.id, `no existe la rúbrica ${job.rubrica_version_id}`);

  let respuesta;
  let salida;
  try {
    const usuario = promptUsuario({ rol: job.rol, direccion: job.direction, duracionSegundos: job.duration_seconds, presupuestoRegistrado, transcripcion });
    respuesta = rubrica ? await evaluar(promptSistemaVersionado(rubrica), usuario, esquemaSalida(rubrica)) : await evaluar(promptSistema(), usuario);
    salida = validarSalida(respuesta.text, rubrica ?? undefined);
  } catch (error) {
    const message = (error as Error).message.slice(0, 500);
    const final = job.intentos >= MAX_INTENTOS;
    console.error(JSON.stringify({ msg: 'calificador_fallo_modelo', evaluacion_id: job.id, intento: job.intentos, final, invalida: error instanceof SalidaInvalida, error: message }));
    if (final) {
      await notifyTech('Calificador: llamada sin evaluar', { evaluacion_id: job.id, llamada_id: job.llamada_id, error: message });
      return noEvaluada(pool, job.id, `el modelo falló ${MAX_INTENTOS} veces: ${message}`);
    }
    const delay = BACKOFF_SEGUNDOS[Math.min(job.intentos - 1, BACKOFF_SEGUNDOS.length - 1)];
    await pool.query(`UPDATE llamada_evaluacion SET estado = 'pendiente', proximo_intento = NOW() + make_interval(secs => $2), actualizado_en = NOW() WHERE id = $1`, [job.id, delay]);
    return 'reintento';
  }

  if (!salida.llamada_evaluable) return noEvaluada(pool, job.id, `no evaluable: ${salida.motivo_no_evaluable}`);

  const d = decidir(salida, transcripcion, {
    presupuestoRegistrado, supervisor: config.supervisorNombre,
    ...(rubrica ? { notaApto: rubrica.nota_apto, nombresReglas: Object.fromEntries(rubrica.errores_criticos.map((e) => [e.codigo, e.nombre])) } : {}),
  });
  const feedback = textoFeedback({
    cuando: madrid(new Date(job.occurred_at)), duracionSegundos: job.duration_seconds, nota: salida.nota, apto: d.apto,
    bien: salida.bien, mejorar: salida.mejorar, escalado: d.escalado, motivoEscalado: d.motivo_escalado, supervisor: config.supervisorNombre,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE llamada_evaluacion SET estado = 'evaluada', motivo_no_evaluada = NULL, nota = $2, apto = $3, errores_criticos = $4, errores_descartados = $5,
         bien = $6, mejorar = $7, escalado = $8, motivo_escalado = $9, duda = $10, motivo_duda = $11, feedback_texto = $12,
         version_rubrica = $13, modelo = $14, tokens_entrada = $15, tokens_salida = $16, puntuacion_pasos = $17, actualizado_en = NOW()
       WHERE id = $1`,
      [job.id, salida.nota, d.apto, JSON.stringify(d.errores_criticos), JSON.stringify(d.errores_descartados), salida.bien, JSON.stringify(salida.mejorar),
        d.escalado, d.motivo_escalado, d.duda, d.motivo_duda, feedback, rubrica?.codigo ?? VERSION_RUBRICA, respuesta.model, respuesta.inputTokens, respuesta.outputTokens,
        salida.pasos ? JSON.stringify(salida.pasos) : null],
    );
    await client.query('DELETE FROM objecion_marketing WHERE evaluacion_id = $1', [job.id]);
    for (const o of d.objeciones) {
      await client.query('INSERT INTO objecion_marketing (llamada_id, evaluacion_id, tipo_objecion, cita, idea_contenido) VALUES ($1, $2, $3, $4, $5)',
        [job.llamada_id, job.id, o.tipo, o.cita, o.idea_contenido]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
  console.log(JSON.stringify({ msg: 'calificador_evaluada', evaluacion_id: job.id, llamada_id: job.llamada_id, rubrica: rubrica?.codigo ?? VERSION_RUBRICA, reevaluacion: job.reevaluacion, nota: salida.nota, apto: d.apto, escalado: d.escalado,
    criticos: d.errores_criticos.length, descartados: d.errores_descartados.length, objeciones: d.objeciones.length, tokens: [respuesta.inputTokens, respuesta.outputTokens] }));
  return 'evaluada';
}

// --- Enviar -----------------------------------------------------------------------------------

/** Mensaje para el supervisor: el mismo feedback, con quién y el enlace a la llamada. */
export function textoSupervisor(feedback: string, nombre: string, extension: string, llamadaId: string, dashboardUrl: string | null): string {
  const enlace = dashboardUrl ? `\n${dashboardUrl.replace(/\/$/, '')}/?view=netelip&call=${llamadaId}` : '';
  return `${nombre} (ext. ${extension})\n${feedback}${enlace}`;
}

/**
 * Envía los feedbacks evaluados y aún no enviados: al comercial y, si hay escalado, a la vez al
 * supervisor. Hasta 3 intentos; el error queda en la evaluación y se avisa a tecnología.
 */
export async function enviarPendientes(pool: Pool, enviar: Enviador, config: ConfigCalificador): Promise<number> {
  if (!config.envioActivo) return 0;
  const { rows } = await pool.query<{ id: string; llamada_id: string; feedback_texto: string; escalado: boolean; extension_netelip: string; nombre: string | null; whatsapp: string | null }>(
    `SELECT e.id, e.llamada_id, e.feedback_texto, e.escalado, e.extension_netelip, r.nombre, r.whatsapp
     FROM llamada_evaluacion e LEFT JOIN comercial_rol r ON r.extension_netelip = e.extension_netelip
     -- llamada_id IS NOT NULL: las reuniones de Meet (869fppbcj) no se envían por WhatsApp; no tienen extensión y cada
     -- intento fallaría y avisaría a Tech.
     WHERE e.estado = 'evaluada' AND NOT e.reevaluacion AND e.llamada_id IS NOT NULL AND e.enviado_en IS NULL AND e.envio_intentos < $1 ORDER BY e.id LIMIT 20`, [MAX_INTENTOS_ENVIO]);
  let enviados = 0;
  for (const row of rows) {
    try {
      if (!row.whatsapp) throw new Error('el comercial no tiene WhatsApp configurado en comercial_rol');
      if (row.escalado && !config.supervisorWhatsapp) throw new Error('escalado sin WhatsApp del supervisor (CALIFICADOR_SUPERVISOR_WHATSAPP)');
      // «El mismo feedback llega a la vez a los dos»: los dos envíos salen juntos.
      await Promise.all([
        enviar(row.whatsapp, row.feedback_texto),
        ...(row.escalado ? [enviar(config.supervisorWhatsapp!, textoSupervisor(row.feedback_texto, row.nombre || 'Comercial', row.extension_netelip, row.llamada_id, config.dashboardUrl))] : []),
      ]);
      await pool.query('UPDATE llamada_evaluacion SET enviado_en = NOW(), envio_error = NULL, envio_intentos = envio_intentos + 1 WHERE id = $1', [row.id]);
      enviados += 1;
    } catch (error) {
      const message = (error as Error).message.slice(0, 300);
      const { rows: [r] } = await pool.query<{ envio_intentos: number }>('UPDATE llamada_evaluacion SET envio_error = $2, envio_intentos = envio_intentos + 1 WHERE id = $1 RETURNING envio_intentos', [row.id, message]);
      if (r?.envio_intentos >= MAX_INTENTOS_ENVIO) await notifyTech('Calificador: feedback sin enviar', { evaluacion_id: row.id, llamada_id: row.llamada_id, error: message });
    }
  }
  return enviados;
}

// --- Feedback de Ernesto ----------------------------------------------------------------------

/** Guarda el comentario del supervisor y, si el envío está activo, se lo manda al comercial. */
export async function anadirFeedbackHumano(pool: Pool, llamadaId: number, autor: { id: string; nombre: string }, texto: string, enviar: Enviador | null, config: ConfigCalificador) {
  const limpio = texto.trim().slice(0, 2000);
  if (!limpio) throw Object.assign(new Error('El comentario está vacío.'), { status: 400 });
  const { rows: [ev] } = await pool.query<{ id: string; whatsapp: string | null; occurred_at: Date }>(
    `SELECT e.id, r.whatsapp, c.occurred_at FROM llamada_evaluacion e JOIN netelip_calls c ON c.id = e.llamada_id
     LEFT JOIN comercial_rol r ON r.extension_netelip = e.extension_netelip WHERE e.llamada_id = $1 AND e.estado = 'evaluada'
     ORDER BY e.reevaluacion, e.creado_en DESC LIMIT 1`, [llamadaId]);
  if (!ev) throw Object.assign(new Error('La llamada no tiene una evaluación a la que añadir feedback.'), { status: 404 });
  const { rows: [fb] } = await pool.query('INSERT INTO llamada_feedback_humano (evaluacion_id, autor_id, autor_nombre, texto) VALUES ($1, $2, $3, $4) RETURNING *', [ev.id, autor.id, autor.nombre, limpio]);
  if (config.envioActivo && enviar && ev.whatsapp) {
    const mensaje = `Feedback de ${autor.nombre || config.supervisorNombre} sobre tu llamada del ${madrid(new Date(ev.occurred_at))}:\n${limpio}`.slice(0, 1000);
    try {
      await enviar(ev.whatsapp, mensaje);
      await pool.query('UPDATE llamada_feedback_humano SET enviado_en = NOW() WHERE id = $1', [fb.id]);
      fb.enviado_en = new Date();
    } catch (error) {
      await pool.query('UPDATE llamada_feedback_humano SET envio_error = $2 WHERE id = $1', [fb.id, (error as Error).message.slice(0, 300)]);
      fb.envio_error = (error as Error).message.slice(0, 300);
    }
  }
  return fb;
}
