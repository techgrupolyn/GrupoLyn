// Reuniones de Meet del calificador interno (869fppbcj) desde la línea de comandos. Ver docs/REUNIONES_MEET_CALIFICADOR.md.
//   npx tsx --env-file=.env scripts/reuniones-meet.ts estado
//   npx tsx --env-file=.env scripts/reuniones-meet.ts reevaluar --version closer_f2-v1 [--desde 2026-11-01] [--hasta 2026-11-30] [--simular] [--ahora]
//   npx tsx --env-file=.env scripts/reuniones-meet.ts coste [--desde …] [--hasta …] > coste.md
import pg from 'pg';
import { RubricaInvalida } from '../netelip/calificador/rubrica.ts';
import { evaluadorGemini } from '../netelip/calificador/modelo.ts';
import { configReunionesDesdeEnv, encolarReuniones, procesarSiguienteReunion } from '../reuniones-meet/evaluacion.ts';
import { conCoste, costePorReunion, estadoReuniones, informeCoste, preciosDesdeEnv } from '../reuniones-meet/informe.ts';
import { reevaluarReuniones } from '../reuniones-meet/reevaluar.ts';

const [orden, ...resto] = process.argv.slice(2);
const opcion = (nombre: string) => { const i = resto.indexOf(`--${nombre}`); return i >= 0 ? resto[i + 1] : undefined; };
const bandera = (nombre: string) => resto.includes(`--${nombre}`);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/** Procesa la cola de reuniones aquí mismo (útil en local o con los procesos del backend parados). */
async function procesarAhora(): Promise<void> {
  const evaluar = evaluadorGemini(process.env);
  if (!evaluar) throw new Error('falta GOOGLE_GEMINI_API_KEY');
  await encolarReuniones(pool);
  const config = configReunionesDesdeEnv(process.env);
  let n = 0;
  for (let r = await procesarSiguienteReunion(pool, evaluar, config); r; r = await procesarSiguienteReunion(pool, evaluar, config)) {
    n++; console.log(`  ${n}: ${r}`);
    if (r === 'reintento') break;
  }
}

async function main() {
  switch (orden) {
    case 'estado': {
      for (const r of await estadoReuniones(pool)) console.log(`${r.estado.padEnd(18)} ${String(r.fase ?? '—').padEnd(4)} ${r.n}`);
      return;
    }
    case 'reevaluar': {
      const res = await reevaluarReuniones(pool, { codigo: opcion('version') || '', desde: opcion('desde'), hasta: opcion('hasta'), simular: bandera('simular') });
      console.log(JSON.stringify(res, null, 2));
      if (bandera('ahora') && !bandera('simular')) await procesarAhora();
      else if (!bandera('simular') && (res.por_evaluar || res.reevaluaciones_creadas)) console.log('Las evaluará el proceso de reuniones del backend en los próximos minutos.');
      return;
    }
    case 'coste': {
      const filas = conCoste(await costePorReunion(pool, { desde: opcion('desde'), hasta: opcion('hasta') }), preciosDesdeEnv(process.env));
      process.stdout.write(informeCoste(filas, preciosDesdeEnv(process.env), new Date().toISOString().slice(0, 10)));
      return;
    }
    default:
      console.log('Órdenes: estado · reevaluar --version <codigo> [--desde <día>] [--hasta <día>] [--simular] [--ahora] · coste [--desde <día>] [--hasta <día>]');
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof RubricaInvalida ? `Rúbrica: ${error.message}` : (error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
