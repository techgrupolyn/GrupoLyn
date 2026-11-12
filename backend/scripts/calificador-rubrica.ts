// Rúbricas del calificador (869fpj8dm) desde la línea de comandos. Ver docs/CALIFICADOR_RUBRICAS.md.
//   npx tsx --env-file=.env scripts/calificador-rubrica.ts listar
//   npx tsx --env-file=.env scripts/calificador-rubrica.ts publicar rubrica.json [--activar]
//   npx tsx --env-file=.env scripts/calificador-rubrica.ts activar sdr-v2
//   npx tsx --env-file=.env scripts/calificador-rubrica.ts reevaluar --version sdr-v2 --desde 2026-11-01 --hasta 2026-11-15 [--simular] [--ahora]
//   npx tsx --env-file=.env scripts/calificador-rubrica.ts calibracion-plantilla --desde … --hasta … [--n 10] [--rol sdr] [--version sdr-v1] > calibracion.csv
//   npx tsx --env-file=.env scripts/calificador-rubrica.ts calibracion-informe calibracion.csv > informe.md
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { activarRubrica, listarRubricas, publicarRubrica, RubricaInvalida, validarDefinicion } from '../netelip/calificador/rubrica.ts';
import { crearReevaluaciones } from '../netelip/calificador/reevaluar.ts';
import { reevaluarReuniones } from '../reuniones-meet/reevaluar.ts';
import { comparar, evaluacionesIA, informeCalibracion, leerCalibracion, plantillaCalibracion } from '../netelip/calificador/calibracion.ts';
import { evaluadorGemini } from '../netelip/calificador/modelo.ts';
import { configDesdeEnv, procesarSiguienteEvaluacion } from '../netelip/calificador/proceso.ts';

const [orden, ...resto] = process.argv.slice(2);
const opcion = (nombre: string) => { const i = resto.indexOf(`--${nombre}`); return i >= 0 ? resto[i + 1] : undefined; };
const bandera = (nombre: string) => resto.includes(`--${nombre}`);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  switch (orden) {
    case 'listar': {
      for (const r of await listarRubricas(pool)) {
        console.log(`${r.activo ? '●' : '○'} ${r.codigo.padEnd(10)} rol ${r.rol.padEnd(9)} v${r.version} · ${r.criterios.length} pasos · ${r.errores_criticos.map((e) => e.codigo).join(', ')}`);
      }
      return;
    }
    case 'publicar': {
      const archivo = resto.find((x) => !x.startsWith('--'));
      if (!archivo) throw new RubricaInvalida('indica el archivo JSON de la rúbrica');
      const definicion = validarDefinicion(JSON.parse(readFileSync(archivo, 'utf8')));
      const r = await publicarRubrica(pool, definicion, { activar: bandera('activar'), autor: process.env.USER || process.env.USERNAME || 'script' });
      console.log(`Publicada ${r.codigo}${r.activo ? ' y activa: las llamadas nuevas del rol ' + r.rol + ' se evalúan con ella' : ' (inactiva: actívala con «activar ' + r.codigo + '»)'}.`);
      return;
    }
    case 'activar': {
      const r = await activarRubrica(pool, resto[0]);
      console.log(`${r.codigo} es ahora la rúbrica vigente de ${r.rol}. Las evaluaciones anteriores conservan su versión.`);
      return;
    }
    case 'reevaluar': {
      const res = await crearReevaluaciones(pool, { codigo: opcion('version') || '', desde: opcion('desde') || '', hasta: opcion('hasta') || '', simular: bandera('simular') });
      console.log(JSON.stringify(res, null, 2));
      // Rúbricas de closer (869fppbcj): también las reuniones de Meet de esa fase, las «sin rúbrica» incluidas.
      const reuniones = await reevaluarReuniones(pool, { codigo: opcion('version') || '', desde: opcion('desde'), hasta: opcion('hasta'), simular: bandera('simular') });
      if (reuniones.fase) {
        console.log(JSON.stringify({ reuniones }, null, 2));
        if (bandera('ahora') && (reuniones.por_evaluar || reuniones.reevaluaciones_creadas)) console.log('Para evaluar las reuniones ya: scripts/reuniones-meet.ts reevaluar --version … --ahora');
      }
      if (bandera('ahora') && res.creadas) {
        // Procesa la cola aquí mismo (útil en local o con los procesos del backend parados).
        const evaluar = evaluadorGemini(process.env);
        if (!evaluar) throw new Error('falta GOOGLE_GEMINI_API_KEY');
        const config = configDesdeEnv(process.env);
        let n = 0;
        for (let r = await procesarSiguienteEvaluacion(pool, evaluar, config); r; r = await procesarSiguienteEvaluacion(pool, evaluar, config)) {
          n++; console.log(`  ${n}: ${r}`);
          if (r === 'esperando_transcripcion' || r === 'reintento') break;
        }
      } else if (res.creadas) console.log('Las evaluará la cola del backend (CALIFICADOR_ENABLED) en los próximos minutos.');
      return;
    }
    case 'calibracion-plantilla': {
      process.stdout.write(await plantillaCalibracion(pool, { desde: opcion('desde') || '', hasta: opcion('hasta') || '', n: Number(opcion('n') || 10), rol: opcion('rol') || 'sdr', version: opcion('version') }));
      return;
    }
    case 'calibracion-informe': {
      const humanas = leerCalibracion(readFileSync(resto[0], 'utf8'));
      const ia = await evaluacionesIA(pool, humanas.map((h) => h.evaluacion_id));
      process.stdout.write(informeCalibracion(comparar(humanas, ia), new Date().toISOString().slice(0, 10)));
      return;
    }
    default:
      console.log('Órdenes: listar · publicar <json> [--activar] · activar <codigo> · reevaluar --version <codigo> --desde <día> --hasta <día> [--simular] [--ahora] · calibracion-plantilla · calibracion-informe <csv>');
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
