// Reevaluación bajo demanda (869fpj8dm): vuelve a evaluar con otra versión de la rúbrica las llamadas ya
// evaluadas de un rango. Crea filas nuevas (reevaluacion = TRUE) que procesa la cola normal; nunca toca las
// anteriores, no se envían al comercial y salta las llamadas «sin consentimiento».
import type { Pool } from 'pg';
import { rubricaPorCodigo, RubricaInvalida } from './rubrica.ts';

export type PeticionReevaluacion = { codigo: string; desde: string; hasta: string; simular?: boolean };
export type ResultadoReevaluacion = { codigo: string; rol: string; candidatas: number; creadas: number; ya_evaluadas_con_esa_version: number; sin_consentimiento: number };

const DIA = /^\d{4}-\d{2}-\d{2}$/;

export async function crearReevaluaciones(pool: Pool, p: PeticionReevaluacion): Promise<ResultadoReevaluacion> {
  if (!DIA.test(p.desde) || !DIA.test(p.hasta) || p.desde > p.hasta) throw new RubricaInvalida('fechas: --desde y --hasta en formato AAAA-MM-DD, desde ≤ hasta');
  const rubrica = await rubricaPorCodigo(pool, p.codigo);
  if (!rubrica) throw new RubricaInvalida(`no existe la rúbrica ${p.codigo}`);
  // Llamadas del rol con alguna evaluación hecha en el rango (fecha de la llamada, hora de Madrid).
  const base = `FROM llamada_evaluacion e JOIN netelip_calls c ON c.id = e.llamada_id
     WHERE e.rol = $1 AND e.estado = 'evaluada' AND (c.occurred_at AT TIME ZONE 'Europe/Madrid')::date BETWEEN $2::date AND $3::date`;
  const params = [rubrica.rol, p.desde, p.hasta];
  const { rows: [c] } = await pool.query<{ candidatas: number; con_version: number; sin_consentimiento: number }>(
    `SELECT COUNT(DISTINCT e.llamada_id)::int AS candidatas,
            COUNT(DISTINCT e.llamada_id) FILTER (WHERE EXISTS (SELECT 1 FROM llamada_evaluacion v WHERE v.llamada_id = e.llamada_id AND v.rubrica_version_id = $4))::int AS con_version,
            COUNT(DISTINCT e.llamada_id) FILTER (WHERE EXISTS (SELECT 1 FROM llamada_evaluacion s WHERE s.llamada_id = e.llamada_id AND s.sin_consentimiento))::int AS sin_consentimiento
     ${base}`, [...params, rubrica.id]);
  let creadas = 0;
  if (!p.simular) {
    const { rowCount } = await pool.query(
      `INSERT INTO llamada_evaluacion (llamada_id, extension_netelip, empleado_id, rol, rubrica_version_id, reevaluacion)
       SELECT DISTINCT ON (e.llamada_id) e.llamada_id, e.extension_netelip, e.empleado_id, e.rol, $4, TRUE
       ${base}
         AND NOT EXISTS (SELECT 1 FROM llamada_evaluacion s WHERE s.llamada_id = e.llamada_id AND s.sin_consentimiento)
       ORDER BY e.llamada_id, e.creado_en
       ON CONFLICT DO NOTHING`, [...params, rubrica.id]);
    creadas = rowCount || 0;
  }
  return { codigo: rubrica.codigo, rol: rubrica.rol, candidatas: c.candidatas, creadas, ya_evaluadas_con_esa_version: c.con_version, sin_consentimiento: c.sin_consentimiento };
}
