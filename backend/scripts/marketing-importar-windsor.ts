// Importa al panel de marketing una exportación JSON de Windsor (lista de filas con date, campaign_id,
// campaign, adset_id, adset_name, ad_id, ad_name, spend, clicks, impressions), por ejemplo la descargada desde
// el panel de Windsor cuando el backend aún no tiene WINDSOR_API_KEY. Sustituye el gasto del canal en el
// rango de fechas del archivo y deja constancia en mk_carga.
//   npx tsx --env-file=.env scripts/marketing-importar-windsor.ts archivo.json [--canal meta|google]
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { filaDesdeWindsor, guardarGasto, type FilaGasto } from '../marketing/windsor.ts';

const [archivo, ...resto] = process.argv.slice(2);
const canal = (resto[resto.indexOf('--canal') + 1] === 'google' ? 'google' : 'meta') as 'meta' | 'google';
if (!archivo) { console.error('Uso: marketing-importar-windsor.ts archivo.json [--canal meta|google]'); process.exit(1); }

const crudo = JSON.parse(readFileSync(archivo, 'utf8')) as unknown;
const filasCrudas = Array.isArray(crudo) ? crudo : (crudo as { data?: unknown[] }).data;
if (!Array.isArray(filasCrudas)) throw new Error('el archivo no contiene una lista de filas de Windsor');
// Mismas reglas que la carga por API: filas repetidas de un mismo anuncio y día se suman.
const porClave = new Map<string, FilaGasto>();
for (const raw of filasCrudas) {
  const f = filaDesdeWindsor(canal, raw as Record<string, unknown>);
  if (!f) continue;
  const k = [f.fecha, f.campana_id, f.conjunto_id, f.anuncio_id].join('|');
  const prev = porClave.get(k);
  if (prev) { prev.gasto += f.gasto; prev.clics += f.clics; prev.impresiones += f.impresiones; prev.leads += f.leads; } else porClave.set(k, f);
}
const filas = [...porClave.values()];
if (!filas.length) throw new Error('ninguna fila válida en el archivo');
const fechas = filas.map((f) => f.fecha).sort();
const [desde, hasta] = [fechas[0], fechas[fechas.length - 1]];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const n = await guardarGasto(pool, canal, desde, hasta, filas);
  await pool.query(`INSERT INTO mk_carga (fuente, fin, estado, filas, detalle) VALUES ('windsor', NOW(), 'ok', $1, $2)`,
    [n, `importado de archivo (${canal}, ${desde} a ${hasta})`]);
  const total = filas.reduce((s, f) => s + f.gasto, 0);
  console.log(`Importadas ${n} filas de ${canal} del ${desde} al ${hasta}: ${total.toFixed(2)} € en ${new Set(filas.map((f) => f.campana_id)).size} campañas.`);
} finally {
  await pool.end();
}
