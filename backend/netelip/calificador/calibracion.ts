// Calibración de la rúbrica con Alex y Ernesto (869fpj8dm): plantilla para puntuar a ciegas y comparación
// con la IA. Hay acuerdo en una llamada si coinciden los errores críticos y la nota difiere 10 puntos o
// menos; la calibración se supera con acuerdo en al menos 8 de 10 llamadas.
import type { Pool } from 'pg';

export const DIFERENCIA_MAXIMA = 10;
export const ACUERDO_MINIMO = 0.8;

export type FilaHumana = { evaluacion_id: string; evaluador: string; nota_humana: number; errores_humanos: string[] };
export type FilaIA = { evaluacion_id: string; llamada_id: string; version_rubrica: string | null; nota: number | null; errores: string[] };
export type Comparacion = FilaHumana & { llamada_id: string; version_rubrica: string | null; nota_ia: number | null; errores_ia: string[]; diferencia: number | null; errores_coinciden: boolean; acuerdo: boolean };

const SEP = ';';
const COLUMNAS = ['evaluacion_id', 'llamada_id', 'fecha', 'duracion_min', 'extension', 'evaluador', 'nota_humana', 'errores_humanos'];

/** Plantilla CSV para puntuar a ciegas: sin la nota ni los errores de la IA, y sin datos del cliente. */
export async function plantillaCalibracion(pool: Pool, args: { desde: string; hasta: string; n: number; rol: string; version?: string }): Promise<string> {
  const { rows } = await pool.query<{ id: string; llamada_id: string; fecha: string; duracion: number; extension: string }>(
    `SELECT e.id, e.llamada_id, to_char(c.occurred_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD HH24:MI') AS fecha,
            ROUND(c.duration_seconds / 60.0)::int AS duracion, e.extension_netelip AS extension
     FROM llamada_evaluacion e JOIN netelip_calls c ON c.id = e.llamada_id
     WHERE e.rol = $1 AND e.estado = 'evaluada' AND ($4::text IS NULL OR e.version_rubrica = $4)
       AND (c.occurred_at AT TIME ZONE 'Europe/Madrid')::date BETWEEN $2::date AND $3::date
     ORDER BY random() LIMIT $5`, [args.rol, args.desde, args.hasta, args.version ?? null, args.n]);
  return [COLUMNAS.join(SEP), ...rows.map((r) => [r.id, r.llamada_id, r.fecha, r.duracion, r.extension, '', '', ''].join(SEP))].join('\n') + '\n';
}

/** Lee la plantilla rellena. `errores_humanos`: códigos separados por comas (vacío = ninguno). */
export function leerCalibracion(csv: string): FilaHumana[] {
  const [cabecera, ...lineas] = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const cols = cabecera.split(SEP).map((c) => c.trim());
  const idx = (c: string) => { const i = cols.indexOf(c); if (i < 0) throw new Error(`falta la columna ${c}`); return i; };
  return lineas.flatMap((l) => {
    const v = l.split(SEP);
    const nota = v[idx('nota_humana')]?.trim();
    if (!nota) return []; // sin puntuar todavía
    const n = Number(nota);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error(`nota_humana no válida en la evaluación ${v[idx('evaluacion_id')]}`);
    const errores = (v[idx('errores_humanos')] || '').split(',').map((e) => e.trim().toUpperCase()).filter(Boolean);
    return [{ evaluacion_id: v[idx('evaluacion_id')].trim(), evaluador: (v[idx('evaluador')] || '').trim() || 'sin nombre', nota_humana: n, errores_humanos: errores }];
  });
}

export function comparar(humanas: FilaHumana[], ia: FilaIA[]): { filas: Comparacion[]; acuerdos: number; total: number; superada: boolean } {
  const porId = new Map(ia.map((f) => [f.evaluacion_id, f]));
  const filas = humanas.map((h) => {
    const m = porId.get(h.evaluacion_id);
    const erroresIA = [...new Set(m?.errores ?? [])].sort();
    const erroresH = [...new Set(h.errores_humanos)].sort();
    const coinciden = Boolean(m) && erroresIA.join(',') === erroresH.join(',');
    const diferencia = m?.nota == null ? null : Math.abs(m.nota - h.nota_humana);
    return { ...h, llamada_id: m?.llamada_id ?? '?', version_rubrica: m?.version_rubrica ?? null, nota_ia: m?.nota ?? null, errores_ia: erroresIA,
      diferencia, errores_coinciden: coinciden, acuerdo: coinciden && diferencia != null && diferencia <= DIFERENCIA_MAXIMA };
  });
  const acuerdos = filas.filter((f) => f.acuerdo).length;
  return { filas, acuerdos, total: filas.length, superada: filas.length > 0 && acuerdos / filas.length >= ACUERDO_MINIMO };
}

export async function evaluacionesIA(pool: Pool, ids: string[]): Promise<FilaIA[]> {
  const { rows } = await pool.query<{ id: string; llamada_id: string; version_rubrica: string | null; nota: number | null; errores_criticos: Array<{ regla: string }> }>(
    'SELECT id, llamada_id, version_rubrica, nota, errores_criticos FROM llamada_evaluacion WHERE id = ANY($1::bigint[])', [ids]);
  return rows.map((r) => ({ evaluacion_id: String(r.id), llamada_id: String(r.llamada_id), version_rubrica: r.version_rubrica, nota: r.nota, errores: (r.errores_criticos || []).map((e) => e.regla) }));
}

/** Informe de calibración en Markdown (acción 5 del ticket). */
export function informeCalibracion(r: ReturnType<typeof comparar>, fecha: string): string {
  const fila = (f: Comparacion) => `| ${f.llamada_id} | ${f.version_rubrica ?? '—'} | ${f.evaluador} | ${f.nota_ia ?? '—'} | ${f.nota_humana} | ${f.diferencia ?? '—'} | ${f.errores_ia.join(', ') || 'ninguno'} | ${f.errores_humanos.join(', ') || 'ninguno'} | ${f.acuerdo ? 'Sí' : 'No'} |`;
  return `# Informe de calibración del calificador · ${fecha}

**Resultado: ${r.superada ? 'SUPERADA' : 'NO SUPERADA'}** · acuerdo en ${r.acuerdos} de ${r.total} llamadas (mínimo: ${Math.ceil(ACUERDO_MINIMO * 10)} de 10).
Hay acuerdo cuando coinciden los errores críticos y la nota difiere ${DIFERENCIA_MAXIMA} puntos o menos.

| Llamada | Rúbrica | Evaluador | Nota IA | Nota humana | Diferencia | Errores IA | Errores humanos | Acuerdo |
|---|---|---|---:|---:|---:|---|---|---|
${r.filas.map(fila).join('\n')}

## Cambios hechos

${r.superada ? 'Ninguno: la rúbrica queda calibrada.' : 'Pendiente: ajustar la rúbrica, publicar una versión nueva y reevaluar estas llamadas (ver docs/CALIFICADOR_RUBRICAS.md).'}
`;
}
