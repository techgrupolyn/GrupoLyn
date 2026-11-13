// Carga diaria e idempotente de Windsor y ClickUp, con registro en mk_carga.
import type { Pool } from 'pg';
import { cargarWindsor, windsorConfigDesdeEnv, type Fetch } from './windsor.ts';
import { clickupConfigDesdeEnv, guardarLeads, leerLeads } from './clickup.ts';
import { diaMadrid } from './periodos.ts';

export type Fuente = 'windsor' | 'clickup';

async function registrar(pool: Pool, fuente: Fuente, tarea: () => Promise<number>) {
  const { rows: [{ id }] } = await pool.query(`INSERT INTO mk_carga (fuente) VALUES ($1) RETURNING id`, [fuente]);
  try {
    const filas = await tarea();
    await pool.query(`UPDATE mk_carga SET fin = NOW(), estado = 'ok', filas = $2 WHERE id = $1`, [id, filas]);
    return { fuente, estado: 'ok' as const, filas };
  } catch (error) {
    const detalle = (error as Error).message.slice(0, 500);
    await pool.query(`UPDATE mk_carga SET fin = NOW(), estado = 'error', detalle = $2 WHERE id = $1`, [id, detalle]);
    return { fuente, estado: 'error' as const, detalle };
  }
}

/** Rango de gasto: desde el día 1 de hace 7 meses hasta ayer (hora de Madrid). Cubre las dos ventanas. */
export function rangoGasto(ahora: Date = new Date()) {
  const [y, m, d] = diaMadrid(ahora).split('-').map(Number);
  const desde = new Date(Date.UTC(y, m - 1 - 7, 1)).toISOString().slice(0, 10);
  const hasta = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  return { desde, hasta };
}

export async function ejecutarCarga(pool: Pool, env: NodeJS.ProcessEnv, fuentes: Fuente[] = ['windsor', 'clickup'], f: Fetch = fetch, ahora = new Date()) {
  const out = [];
  if (fuentes.includes('windsor')) {
    const w = windsorConfigDesdeEnv(env);
    if (w) { const { desde, hasta } = rangoGasto(ahora); out.push(await registrar(pool, 'windsor', () => cargarWindsor(pool, w, desde, hasta, f))); }
  }
  if (fuentes.includes('clickup')) {
    const c = clickupConfigDesdeEnv(env);
    if (c) out.push(await registrar(pool, 'clickup', async () => guardarLeads(pool, await leerLeads(c, f))));
  }
  return out;
}

/** Fuentes que aún no tienen una carga correcta hoy (Madrid) y ya pasó la hora configurada. */
export async function fuentesPendientesHoy(pool: Pool, env: NodeJS.ProcessEnv, ahora = new Date()): Promise<Fuente[]> {
  const hora = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }).format(ahora));
  if (hora < Number(env.MARKETING_CARGA_HORA ?? 6)) return [];
  const configuradas: Fuente[] = [];
  if (windsorConfigDesdeEnv(env)) configuradas.push('windsor');
  if (clickupConfigDesdeEnv(env)) configuradas.push('clickup');
  if (!configuradas.length) return [];
  // Hecha: correcta hoy, en curso, o con error hace menos de una hora (un fallo de permisos no se reintenta cada 15 min).
  const { rows } = await pool.query(
    `SELECT DISTINCT fuente FROM mk_carga
     WHERE (estado = 'ok' OR estado = 'en_curso' AND inicio > NOW() - INTERVAL '2 hours' OR estado = 'error' AND inicio > NOW() - INTERVAL '1 hour')
       AND (inicio AT TIME ZONE 'Europe/Madrid')::date = $1::date`,
    [diaMadrid(ahora)]);
  const hechas = new Set(rows.map((r) => r.fuente));
  return configuradas.filter((f) => !hechas.has(f));
}

const INTERVALO_MS = 15 * 60_000;

export function createMarketingWorker(pool: Pool, env: NodeJS.ProcessEnv = process.env) {
  let enCurso = false;
  const ciclo = async () => {
    if (enCurso) return;
    enCurso = true;
    try {
      const pendientes = await fuentesPendientesHoy(pool, env);
      if (!pendientes.length) return;
      const res = await ejecutarCarga(pool, env, pendientes);
      console.log(JSON.stringify({ msg: 'marketing_carga', resultados: res }));
    } catch (error) {
      console.error('[marketing] Error en la carga diaria:', (error as Error).message);
    } finally { enCurso = false; }
  };
  return {
    start() {
      if (env.MARKETING_CARGA_ENABLED === 'false') return;
      if (!windsorConfigDesdeEnv(env)) console.warn('[marketing] Sin WINDSOR_API_KEY: el panel no tendrá gasto');
      if (!clickupConfigDesdeEnv(env)) console.warn('[marketing] Sin CLICKUP_API_TOKEN: el panel no tendrá leads');
      void ciclo();
      setInterval(() => void ciclo(), INTERVALO_MS).unref();
    },
  };
}
