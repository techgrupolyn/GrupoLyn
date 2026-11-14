// Reevaluación bajo demanda de las reuniones de Meet (869fppbcj, bloque D) al publicar o activar una rúbrica de closer.
// La lanza el script de rúbricas de 869fpj8dm (scripts/calificador-rubrica.ts reevaluar) o scripts/reuniones-meet.ts.
//
//   1. Las reuniones `sin_rubrica` de la fase de esa rúbrica vuelven a `pendiente`; la vinculación las pasa a
//      `por_evaluar` con la versión activa, y la cola las evalúa. Requiere que la rúbrica esté activa.
//   2. Las reuniones ya evaluadas de esa fase con otra versión reciben una evaluación nueva (reevaluacion = TRUE),
//      sin tocar la anterior, como las llamadas.
//   Nunca entra una reunión `sin_consentimiento`.
import type { Pool } from 'pg';
import { rubricaPorCodigo, RubricaInvalida } from '../netelip/calificador/rubrica.ts';
import { vincularPendientes } from './proceso.ts';
import type { FaseReunion } from './schema.ts';

type Consultable = Pick<Pool, 'query'>;

export const FASE_DE_ROL: Record<string, FaseReunion> = { closer_f2: 'F2', closer_f3: 'F3', closer_f4: 'F4' };

export type PeticionReevaluacionReuniones = { codigo: string; desde?: string; hasta?: string; simular?: boolean };
export type ResultadoReevaluacionReuniones = {
  codigo: string; fase: FaseReunion | null; activa: boolean;
  sin_rubrica: number; reabiertas: number; por_evaluar: number;
  evaluadas_con_otra_version: number; reevaluaciones_creadas: number; nota: string | null;
};

const DIA = /^\d{4}-\d{2}-\d{2}$/;

export async function reevaluarReuniones(pool: Consultable, p: PeticionReevaluacionReuniones): Promise<ResultadoReevaluacionReuniones> {
  if ((p.desde && !DIA.test(p.desde)) || (p.hasta && !DIA.test(p.hasta)) || (p.desde && p.hasta && p.desde > p.hasta)) {
    throw new RubricaInvalida('fechas: --desde y --hasta en formato AAAA-MM-DD, desde ≤ hasta');
  }
  const rubrica = await rubricaPorCodigo(pool as Pool, p.codigo);
  if (!rubrica) throw new RubricaInvalida(`no existe la rúbrica ${p.codigo}`);
  const fase = FASE_DE_ROL[rubrica.rol] ?? null;
  const vacio = { codigo: rubrica.codigo, fase, activa: rubrica.activo, sin_rubrica: 0, reabiertas: 0, por_evaluar: 0, evaluadas_con_otra_version: 0, reevaluaciones_creadas: 0 };
  if (!fase) return { ...vacio, nota: `La rúbrica ${rubrica.codigo} es de ${rubrica.rol}: no aplica a reuniones de closers.` };

  // Rango opcional por la fecha de la reunión.
  const rango = `($2::date IS NULL OR r.fecha_reunion >= $2::date) AND ($3::date IS NULL OR r.fecha_reunion <= $3::date)`;
  const params = [fase, p.desde ?? null, p.hasta ?? null];
  const { rows: [c] } = await pool.query<{ sin_rubrica: number; otra: number }>(
    `SELECT COUNT(*) FILTER (WHERE r.estado = 'sin_rubrica')::int AS sin_rubrica,
            COUNT(*) FILTER (WHERE r.estado = 'evaluada' AND NOT EXISTS (
              SELECT 1 FROM llamada_evaluacion v WHERE v.reunion_id = r.id AND v.rubrica_version_id = $4))::int AS otra
     FROM reunion r WHERE r.fase = $1 AND ${rango}`,
    [...params, rubrica.id],
  );
  const resultado = { ...vacio, sin_rubrica: c.sin_rubrica, evaluadas_con_otra_version: c.otra };
  if (p.simular) return { ...resultado, nota: 'Simulación: no se ha cambiado nada.' };

  let reabiertas = 0;
  let porEvaluar = 0;
  let nota: string | null = null;
  if (rubrica.activo) {
    reabiertas = (await pool.query(
      `UPDATE reunion r SET estado = 'pendiente', motivo = NULL, actualizado_en = NOW() WHERE r.estado = 'sin_rubrica' AND r.fase = $1 AND ${rango}`, params,
    )).rowCount || 0;
    // Vincularlas ya, para que el resultado diga cuántas quedan listas para la cola.
    while ((await vincularPendientes(pool)) > 0) { /* siguiente lote */ }
    porEvaluar = (await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM reunion r WHERE r.estado = 'por_evaluar' AND r.fase = $1 AND r.rubrica_version_id = $4::text AND ${rango}`,
      [...params, rubrica.id],
    )).rows[0].n;
  } else if (c.sin_rubrica) {
    nota = `${rubrica.codigo} no está activa: las ${c.sin_rubrica} reuniones sin rúbrica siguen así hasta activarla.`;
  }
  const creadas = (await pool.query(
    `INSERT INTO llamada_evaluacion (reunion_id, empleado_id, rol, rubrica_version_id, version_rubrica, reevaluacion)
     SELECT r.id, r.empleado_id, r.rol, $4, $5, TRUE FROM reunion r
     WHERE r.estado = 'evaluada' AND r.fase = $1 AND ${rango}
       AND NOT EXISTS (SELECT 1 FROM llamada_evaluacion v WHERE v.reunion_id = r.id AND v.rubrica_version_id = $4)
       AND NOT EXISTS (SELECT 1 FROM llamada_evaluacion s WHERE s.reunion_id = r.id AND s.sin_consentimiento)
     ON CONFLICT DO NOTHING`,
    [...params, rubrica.id, rubrica.codigo],
  )).rowCount || 0;
  return { ...resultado, reabiertas, por_evaluar: porEvaluar, reevaluaciones_creadas: creadas, nota };
}
