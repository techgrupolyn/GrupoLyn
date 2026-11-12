// Informes de las reuniones de Meet (869fppbcj): estado de la cola y tokens / coste por reunión (acción 7 del ticket:
// «45–60 minutos son unos 10.000–15.000 tokens»). El precio por millón de tokens se pasa al llamar, porque cambia
// con el modelo y con el tiempo; sin precio, el informe da solo tokens.
import type { Pool } from 'pg';

type Consultable = Pick<Pool, 'query'>;

export type Precios = { entradaPorMillon: number | null; salidaPorMillon: number | null };

export function preciosDesdeEnv(env: NodeJS.ProcessEnv = process.env): Precios {
  const n = (v: string | undefined) => (v && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  return { entradaPorMillon: n(env.CALIFICADOR_PRECIO_ENTRADA_1M), salidaPorMillon: n(env.CALIFICADOR_PRECIO_SALIDA_1M) };
}

export async function estadoReuniones(pool: Consultable): Promise<Array<{ estado: string; fase: string | null; n: number }>> {
  const { rows } = await pool.query<{ estado: string; fase: string | null; n: number }>(
    `SELECT estado, fase, COUNT(*)::int AS n FROM reunion GROUP BY estado, fase ORDER BY estado, fase NULLS LAST`);
  return rows;
}

export type FilaCoste = { reunion_id: string; fecha: string | null; fase: string | null; minutos: number | null; version: string | null;
  tokens_entrada: number | null; tokens_salida: number | null; coste: number | null };

export async function costePorReunion(pool: Consultable, opciones: { desde?: string; hasta?: string } = {}): Promise<FilaCoste[]> {
  const { rows } = await pool.query<Omit<FilaCoste, 'coste'>>(
    `SELECT r.id::text AS reunion_id, r.fecha_reunion::text AS fecha, r.fase,
            CASE WHEN r.duracion_segundos IS NULL THEN NULL ELSE ROUND(r.duracion_segundos / 60.0)::int END AS minutos,
            e.version_rubrica AS version, e.tokens_entrada, e.tokens_salida
     FROM llamada_evaluacion e JOIN reunion r ON r.id = e.reunion_id
     WHERE e.estado = 'evaluada' AND ($1::date IS NULL OR r.fecha_reunion >= $1::date) AND ($2::date IS NULL OR r.fecha_reunion <= $2::date)
     ORDER BY r.fecha_reunion, r.id, e.creado_en`,
    [opciones.desde ?? null, opciones.hasta ?? null],
  );
  return rows.map((r) => ({ ...r, coste: null }));
}

export function conCoste(filas: FilaCoste[], precios: Precios): FilaCoste[] {
  if (precios.entradaPorMillon === null || precios.salidaPorMillon === null) return filas;
  return filas.map((f) => ({ ...f, coste: f.tokens_entrada === null || f.tokens_salida === null ? null
    : Math.round(((f.tokens_entrada * precios.entradaPorMillon!) + (f.tokens_salida * precios.salidaPorMillon!)) / 1e6 * 10_000) / 10_000 }));
}

/** Informe en Markdown: una fila por evaluación y el resumen (media de tokens por reunión y por minuto). */
export function informeCoste(filas: FilaCoste[], precios: Precios, fecha: string): string {
  const conTokens = filas.filter((f) => f.tokens_entrada !== null && f.tokens_salida !== null);
  const total = (k: 'tokens_entrada' | 'tokens_salida') => conTokens.reduce((s, f) => s + (f[k] || 0), 0);
  const minutos = conTokens.reduce((s, f) => s + (f.minutos || 0), 0);
  const media = conTokens.length ? Math.round((total('tokens_entrada') + total('tokens_salida')) / conTokens.length) : null;
  const porMinuto = minutos ? Math.round((total('tokens_entrada') + total('tokens_salida')) / minutos) : null;
  const costeTotal = filas.every((f) => f.coste === null) ? null : filas.reduce((s, f) => s + (f.coste || 0), 0);
  const dinero = (v: number | null) => (v === null ? '—' : v.toFixed(4));
  return [
    `# Coste de evaluar reuniones de Meet · ${fecha}`,
    '',
    `- Evaluaciones: ${filas.length} (con tokens: ${conTokens.length})`,
    `- Tokens totales: ${total('tokens_entrada')} de entrada y ${total('tokens_salida')} de salida`,
    `- Media por reunión: ${media ?? '—'} tokens · por minuto de reunión: ${porMinuto ?? '—'}`,
    `- Coste total: ${dinero(costeTotal)}${precios.entradaPorMillon === null ? ' (sin precio configurado: CALIFICADOR_PRECIO_ENTRADA_1M y CALIFICADOR_PRECIO_SALIDA_1M)' : ''}`,
    '',
    '| Reunión | Fecha | Fase | Min | Rúbrica | Tokens entrada | Tokens salida | Coste |',
    '|---|---|---|---|---|---|---|---|',
    ...filas.map((f) => `| ${f.reunion_id} | ${f.fecha ?? '—'} | ${f.fase ?? '—'} | ${f.minutos ?? '—'} | ${f.version ?? '—'} | ${f.tokens_entrada ?? '—'} | ${f.tokens_salida ?? '—'} | ${dinero(f.coste)} |`),
    '',
  ].join('\n');
}
