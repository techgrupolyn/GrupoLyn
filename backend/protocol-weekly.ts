import type { Pool } from 'pg';

export function parseWeeklyWindow(from: unknown, to: unknown, now = Date.now()): { from: string; to: string } {
  if (typeof from !== 'string' || typeof to !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(from) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(to)) throw new Error('Periodo inválido');
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || new Date(start).toISOString() !== from ||
      new Date(end).toISOString() !== to || end <= start || end - start > 8 * 86_400_000 ||
      end > now + 86_400_000 || start < now - 366 * 86_400_000) throw new Error('Periodo inválido');
  return { from, to };
}

export async function loadProtocolWeeklySnapshot(pool: Pool, from: string, to: string) {
  const result = await pool.query<{
    id: string; creada_en: Date; rol: string; estado: string; pregunta_original: string;
    pregunta_reformulada: string; tema: string; corpus_version: string; cita_invalida: boolean;
    tokens_entrada: number | null; tokens_salida: number | null;
  }>(`SELECT id, creado_en AS creada_en, cargo AS rol,
      CASE WHEN motivo_no_respuesta='fuera_de_alcance' THEN 'fuera_de_alcance'
        WHEN motivo_no_respuesta IS NOT NULL OR validacion='rechazada' OR resuelta_por_usuario=FALSE OR error IS NOT NULL THEN 'sin_respuesta'
        WHEN contradiccion IS NOT NULL THEN 'parcial' ELSE 'respondida' END AS estado,
      pregunta AS pregunta_original, pregunta AS pregunta_reformulada, tema,
      TRIM(corpus_version_id) AS corpus_version,
      (validacion='rechazada') AS cita_invalida, tokens_entrada, tokens_salida
    FROM agente_protocolos_consultas
    WHERE creado_en >= $1::timestamptz AND creado_en < $2::timestamptz AND clasificacion <> 'aclaracion'
    ORDER BY creado_en, id`, [from, to]);
  const metrics = new Map<string, { estado: string; total: number; entrada: number; cache: number; salida: number }>();
  for (const row of result.rows) {
    const metric = metrics.get(row.estado) || { estado: row.estado, total: 0, entrada: 0, cache: 0, salida: 0 };
    metric.total += 1;
    metric.entrada += Number(row.tokens_entrada || 0);
    metric.salida += Number(row.tokens_salida || 0);
    metrics.set(row.estado, metric);
  }
  return {
    preguntas: result.rows.filter(row => row.estado !== 'respondida').map(row => ({
      id: row.id, creada_en: row.creada_en.toISOString(), rol: row.rol, estado: row.estado,
      pregunta_original: row.pregunta_original, pregunta_reformulada: row.pregunta_reformulada,
      tema: row.tema, corpus_version: row.corpus_version, cita_invalida: row.cita_invalida,
    })),
    metricas: [...metrics.values()],
    documentos: [],
  };
}
