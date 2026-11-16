// Proceso de una llamada para la captación ABCD (N-1.2): vincula la llamada con su lead, enmascara los datos
// personales, pide la evaluación al modelo, valida y guarda (todo o nada) y devuelve lo que habría que
// escribir en ClickUp. No escribe en ClickUp ni decide reintentos: eso es de quien lo llama (la cola o el lote).
import { enmascarar } from '../calificador/reglas.ts';
import type { Evaluador } from '../calificador/modelo.ts';
import { procesarEvaluacionLlamada, type Db, type ResultadoRecalculo } from './repositorio.ts';
import { promptSistema, promptUsuario, VERSION_PROMPT } from './prompt.ts';
import type { Categoria } from './tipos.ts';
import { vincularLlamadaConLead, type LeadCandidato, type ResultadoVinculacion } from './vinculacion.ts';

export interface EntradaLlamada {
  llamadaId: string;
  /** Teléfono de la contraparte en E.164 (`netelip_calls.phone_e164`); null si el número es oculto. */
  telefonoE164: string | null;
  email?: string | null;
  ocurridaEn: Date;
  direccion: string;
  duracionSegundos: number;
  /** Transcripción por turnos, SIN enmascarar. */
  transcripcion: string;
}

export interface Dependencias {
  /**
   * Da una conexión de la base de datos para una operación. `procesarEvaluacionLlamada` abre una transacción:
   * necesita UNA conexión, no el pool. Mientras el modelo contesta no se retiene ninguna.
   */
  conDb: <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
  leads: readonly LeadCandidato[];
  /** Nombre del lead en ClickUp: se sustituye por un marcador antes de que la transcripción salga hacia el modelo. */
  nombreLead: (clickupTaskId: string) => string | null;
  evaluar: Evaluador;
}

export type ResultadoLlamada =
  | { estado: 'sin_lead'; motivo: Extract<ResultadoVinculacion, { estado: 'sin_lead' }>['motivo'] }
  | { estado: 'sin_conversacion' }
  | { estado: 'modelo_fallo'; error: string; clickupTaskId: string }
  | { estado: 'salida_invalida'; error: string; clickupTaskId: string }
  | {
      estado: 'procesada';
      clickupTaskId: string;
      via: 'telefono' | 'email';
      categoria: Categoria;
      escrituras: ResultadoRecalculo['escrituras'];
      /** Citas o datos que el código descartó (con el motivo) y puntos que revisa una persona. */
      descartes: readonly unknown[];
      revisionManual: readonly string[];
      /** Un criterio, presupuesto o No apto nuevo se guardó (false si la llamada ya estaba procesada). */
      nuevo: boolean;
      modelo: string;
      tokens: [number | null, number | null];
      versionPrompt: string;
    };

export const interaccionDe = (llamadaId: string): string => `netelip:${llamadaId}`;

/** AAAA-MM-DD en hora de Madrid. */
const fechaMadrid = (d: Date): string => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};

export async function evaluarLlamadaCaptacion(deps: Dependencias, llamada: EntradaLlamada): Promise<ResultadoLlamada> {
  const vinculo = vincularLlamadaConLead({ telefono: llamada.telefonoE164, email: llamada.email ?? null }, deps.leads);
  if (vinculo.estado === 'sin_lead') return { estado: 'sin_lead', motivo: vinculo.motivo };

  const transcripcion = enmascarar(llamada.transcripcion, [deps.nombreLead(vinculo.clickupTaskId) ?? '']);
  if (!transcripcion.trim()) return { estado: 'sin_conversacion' };

  const interaccionId = interaccionDe(llamada.llamadaId);
  let respuesta;
  try {
    respuesta = await deps.evaluar(
      promptSistema(),
      promptUsuario({ interaccionId, direccion: llamada.direccion, fecha: fechaMadrid(llamada.ocurridaEn), duracionSegundos: llamada.duracionSegundos, transcripcion }),
    );
  } catch (error) {
    return { estado: 'modelo_fallo', error: (error as Error).message.slice(0, 500), clickupTaskId: vinculo.clickupTaskId };
  }

  const resultado = await deps.conDb((db) =>
    procesarEvaluacionLlamada(db, {
      clickupTaskId: vinculo.clickupTaskId,
      interaccionId,
      fechaInteraccion: llamada.ocurridaEn.toISOString(),
      transcripcion,
      salidaModelo: respuesta.text,
    }),
  );
  if (resultado.estado === 'salida_invalida') return { estado: 'salida_invalida', error: resultado.error, clickupTaskId: vinculo.clickupTaskId };

  const { registro, recalculo, descartes } = resultado;
  return {
    estado: 'procesada',
    clickupTaskId: vinculo.clickupTaskId,
    via: vinculo.via,
    categoria: recalculo.agregacion.categoria,
    escrituras: recalculo.escrituras,
    descartes,
    revisionManual: registro.revisionManual,
    nuevo: registro.criterios > 0 || registro.presupuesto || registro.noApto,
    modelo: respuesta.model,
    tokens: [respuesta.inputTokens, respuesta.outputTokens],
    versionPrompt: VERSION_PROMPT,
  };
}
