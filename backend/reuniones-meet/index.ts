// Reuniones de Meet de los closers (ticket 869fppbcj). Ver docs/REUNIONES_MEET_CALIFICADOR.md.
//
//   ensureReunionesMeet(pool)        esquema aditivo (en ensureDatabaseSchema, tras Netelip)
//   createReunionesWorkers(pool)     ingesta y vinculación en segundo plano (en bootstrap)
//
// El «disparador» es un sondeo: cada minuto se recogen las transcripciones nuevas que la sincronización de
// Drive ya guardó. Así no se toca el bucle de sincronización y una caída no pierde reuniones: la siguiente
// vuelta las recoge.
import type { Pool } from 'pg';
import { evaluadorGemini, type Evaluador } from '../netelip/calificador/modelo.ts';
import { configReunionesDesdeEnv, encolarReuniones, procesarSiguienteReunion } from './evaluacion.ts';
import { guardarInvitados, type ObtenerToken } from './invitados.ts';
import { vincularLeads, type BuscarLead } from './lead.ts';
import { ingestarTranscripciones, vincularPendientes } from './proceso.ts';

export { ensureReunionesMeet } from './schema.ts';
export { reabrirSinRubrica } from './proceso.ts';

const INTERVALO_MS = 60_000;

/**
 * tokenGoogle: el token de la conexión de Drive (server.ts). Sin él no se consultan invitados.
 * buscarLead: búsqueda en «Contacto de Reforma» (ClickUp). Sin ella, lead_estado se queda en 'pendiente'.
 */
export type DependenciasReuniones = { tokenGoogle?: ObtenerToken; buscarLead?: BuscarLead; evaluar?: Evaluador | null };

/** Reuniones evaluadas como mucho por vuelta: cada una es una llamada a Gemini de 10.000–15.000 tokens. */
export const EVALUACIONES_POR_VUELTA = 5;

export function createReunionesWorkers(pool: Pool, env: NodeJS.ProcessEnv = process.env, deps: DependenciasReuniones = {}) {
  // Evaluador: el de los tests, o Gemini si hay clave y no está apagado (CALIFICADOR_ENABLED / REUNIONES_MEET_EVALUAR).
  // Sin rúbricas de closer activas nunca hay reuniones por_evaluar, así que el coste es cero.
  const evaluar = deps.evaluar !== undefined ? deps.evaluar
    : env.CALIFICADOR_ENABLED === 'false' || env.REUNIONES_MEET_EVALUAR === 'false' ? null : evaluadorGemini(env);
  const configEvaluacion = configReunionesDesdeEnv(env);
  let enCurso = false;
  const ciclo = async () => {
    if (enCurso) return;
    enCurso = true;
    try {
      let nuevas = 0;
      let vinculadas = 0;
      for (let n; (n = await ingestarTranscripciones(pool)) > 0;) nuevas += n;
      for (let n; (n = await vincularPendientes(pool)) > 0;) vinculadas += n;
      // Un lote por vuelta (no en bucle): cada reunión es una llamada a Calendar y no hay prisa.
      const invitados = deps.tokenGoogle && env.REUNIONES_MEET_INVITADOS !== 'false' ? await guardarInvitados(pool, deps.tokenGoogle) : 0;
      const leads = deps.buscarLead ? await vincularLeads(pool, deps.buscarLead) : 0;
      let evaluadas = 0;
      if (evaluar) {
        await encolarReuniones(pool);
        for (let i = 0; i < EVALUACIONES_POR_VUELTA; i++) {
          const r = await procesarSiguienteReunion(pool, evaluar, configEvaluacion);
          if (!r || r === 'reintento') break;
          evaluadas++;
        }
      }
      if (nuevas || vinculadas || invitados || leads || evaluadas) console.log(JSON.stringify({ msg: 'reuniones_meet', nuevas, vinculadas, invitados, leads, evaluadas }));
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
