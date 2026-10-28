import type { Pool } from 'pg';

export type ProtocolReportFilters = {
  from: string;
  to: string;
  area: string | null;
  role: string | null;
  minCount: number;
};

export function parseProtocolReportFilters(query: Record<string, unknown>, now = new Date()): ProtocolReportFilters {
  const today = now.toISOString().slice(0, 10);
  const previous = new Date(now);
  previous.setUTCDate(previous.getUTCDate() - 6);
  const from = String(query.from || previous.toISOString().slice(0, 10));
  const to = String(query.to || today);
  const area = query.area ? String(query.area) : null;
  const role = query.role ? String(query.role) : null;
  const minCount = query.minCount === undefined ? 3 : Number(query.minCount);
  const dateValid = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!dateValid(from) || !dateValid(to) || from > to || (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) > 366 * 86_400_000) throw new Error('Periodo inválido');
  if (area && (!/^[a-z_]{2,40}$/u.test(area) || !['diseno', 'presupuestos', 'materiales', 'obra', 'revisiones_y_reuniones', 'responsables_y_escalado', 'uso_de_club_lyn', 'otro'].includes(area))) throw new Error('Área inválida');
  if (role && (role.length > 80 || !/^[\p{L}\p{N} :_/-]+$/u.test(role))) throw new Error('Cargo inválido');
  if (!Number.isSafeInteger(minCount) || minCount < 1 || minCount > 100) throw new Error('Umbral inválido');
  return { from, to, area, role, minCount };
}

export async function loadProtocolReport(pool: Pool, filters: ProtocolReportFilters): Promise<{ popular: Record<string, unknown>[]; unanswered: Record<string, unknown>[] }> {
  const upper = new Date(`${filters.to}T00:00:00Z`);
  upper.setUTCDate(upper.getUTCDate() + 1);
  const parameters = [`${filters.from}T00:00:00Z`, upper.toISOString(), filters.area, filters.role, filters.minCount];
  const filtered = `WITH filtered AS (
    SELECT * FROM agente_protocolos_consultas
    WHERE creado_en >= $1::timestamptz AND creado_en < $2::timestamptz
      AND ($3::text IS NULL OR area = $3)
      AND ($4::text IS NULL OR cargo = $4)
      AND clasificacion <> 'aclaracion'
  )`;
  const popular = await pool.query(`${filtered}
    SELECT tema, COUNT(*)::int AS consultas, COUNT(DISTINCT usuario_id)::int AS usuarios,
      ROUND(100.0 * COUNT(*) FILTER (WHERE resuelta_por_usuario IS TRUE) /
        NULLIF(COUNT(*) FILTER (WHERE resuelta_por_usuario IS NOT NULL), 0), 1) AS porcentaje_resueltas,
      MAX(creado_en) AS ultima_consulta,
      (SELECT COALESCE(fuente.value->>'name', fuente.value->>'doc_id')
       FROM filtered item CROSS JOIN LATERAL jsonb_array_elements(item.fuentes) AS fuente(value)
       WHERE item.tema = resumen.tema
       GROUP BY 1 ORDER BY COUNT(*) DESC, 1 ASC LIMIT 1) AS documento_mas_citado
    FROM filtered AS resumen GROUP BY tema HAVING COUNT(*) >= $5
    ORDER BY consultas DESC, tema ASC`, parameters);
  const unanswered = await pool.query(`${filtered}, unanswered AS (
    SELECT * FROM filtered WHERE motivo_no_respuesta IN ('sin_protocolo', 'fuera_de_alcance', 'tema_sensible')
      OR validacion = 'rechazada' OR resuelta_por_usuario IS FALSE
  )
    SELECT tema, COUNT(*)::int AS consultas,
      COUNT(*) FILTER (WHERE motivo_no_respuesta = 'sin_protocolo')::int AS sin_protocolo,
      COUNT(*) FILTER (WHERE motivo_no_respuesta = 'fuera_de_alcance')::int AS fuera_de_alcance,
      COUNT(*) FILTER (WHERE motivo_no_respuesta = 'tema_sensible')::int AS tema_sensible,
      COUNT(*) FILTER (WHERE validacion = 'rechazada')::int AS rechazadas,
      COUNT(*) FILTER (WHERE resuelta_por_usuario IS FALSE)::int AS usuario_dijo_no,
      ARRAY(SELECT DISTINCT cargo FROM unanswered item WHERE item.tema = resumen.tema ORDER BY cargo) AS cargos,
      ARRAY(SELECT pregunta FROM unanswered item WHERE item.tema = resumen.tema ORDER BY creado_en DESC, id DESC LIMIT 3) AS ejemplos
    FROM unanswered AS resumen GROUP BY tema ORDER BY consultas DESC, tema ASC`, parameters);
  return { popular: popular.rows, unanswered: unanswered.rows };
}
