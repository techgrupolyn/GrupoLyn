// Reuniones de Meet de los closers (ticket 869fppbcj). Ver docs/REUNIONES_MEET_CALIFICADOR.md.
//
//   ensureReunionesMeet(pool)        esquema aditivo (en ensureDatabaseSchema, tras Netelip)
//   createReunionesWorkers(pool)     ingesta y vinculación en segundo plano (en bootstrap)
//
// El «disparador» es un sondeo: cada minuto se recogen las transcripciones nuevas que la sincronización de
// Drive ya guardó. Así no se toca el bucle de sincronización y una caída no pierde reuniones: la siguiente
// vuelta las recoge.
import type { Pool } from 'pg';
import { ingestarTranscripciones, vincularPendientes } from './proceso.ts';

export { ensureReunionesMeet } from './schema.ts';
export { reabrirSinRubrica } from './proceso.ts';

const INTERVALO_MS = 60_000;

export function createReunionesWorkers(pool: Pool, env: NodeJS.ProcessEnv = process.env) {
  let enCurso = false;
  const ciclo = async () => {
    if (enCurso) return;
    enCurso = true;
    try {
      let nuevas = 0;
      let vinculadas = 0;
      for (let n; (n = await ingestarTranscripciones(pool)) > 0;) nuevas += n;
      for (let n; (n = await vincularPendientes(pool)) > 0;) vinculadas += n;
      if (nuevas || vinculadas) console.log(JSON.stringify({ msg: 'reuniones_meet', nuevas, vinculadas }));
    } catch (error) {
      console.error('[reuniones-meet] Error en el ciclo:', (error as Error).message);
    } finally {
      enCurso = false;
    }
  };
  return {
    ciclo,
    start() {
      if (env.REUNIONES_MEET_ENABLED === 'false') return;
      void ciclo();
      setInterval(() => void ciclo(), INTERVALO_MS).unref();
    },
  };
}
