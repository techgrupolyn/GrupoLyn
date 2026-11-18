// Proceso de una llamada para la captación ABCD (N-1.2): vincula la llamada con su lead, enmascara los datos
// personales, pide la evaluación al modelo, valida y guarda (todo o nada) y devuelve lo que habría que
// escribir en ClickUp. No escribe en ClickUp ni decide reintentos: eso es de quien lo llama (la cola o el lote).
import { enmascarar } from '../calificador/reglas.ts';
import type { Evaluador } from '../calificador/modelo.ts';
import { generaDecision, type Origen } from './decision.ts';
import { cargarContexto, cargarMotivos } from './decision-repositorio.ts';
import { cargarResumenVigente, procesarEvaluacionLlamada, type Db, type ResultadoDecisionGuardada, type ResultadoRecalculo, type ResultadoResumenGuardado } from './repositorio.ts';
import { CONTEXTO_POR_DEFECTO, promptSistema, promptUsuario, VERSION_PROMPT, type ContextoDecision } from './prompt.ts';
import { fechaMadrid } from './resumen.ts';
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
  /**
   * Número de la etapa de CRM del lead (e4 VISITA = F2 = 4). Un lead en F2 o más allá no genera decisión de pase (N-1.4). Sin esta
   * función, o sin etapa conocida, sí se genera.
   */
  etapaLead?: (clickupTaskId: string) => number | null;
  /** `historico` en la calibración con llamadas antiguas: la decisión de la IA se guarda pero no entra en la bandeja ni en el acierto. */
  origenDecision?: Origen;
}

/** Guion, manual y motivos vigentes de la decisión de pase. Sin ellos (tablas sin configurar) la llamada se califica igual. */
async function leerConfigDecision(db: Db): Promise<ContextoDecision | null> {
  try {
    const { guion, manual } = await cargarContexto(db);
    return { guion, manual, motivos: await cargarMotivos(db) };
  } catch {
    return null;
  }
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
      /** Qué pasó con el resumen ejecutivo de esta llamada. */
      resumen: ResultadoResumenGuardado;
      /** Qué pasó con la decisión de pase de la IA. */
      decision: ResultadoDecisionGuardada;
      modelo: string;
      tokens: [number | null, number | null];
      versionPrompt: string;
    };

export const interaccionDe = (llamadaId: string): string => `netelip:${llamadaId}`;

export async function evaluarLlamadaCaptacion(deps: Dependencias, llamada: EntradaLlamada): Promise<ResultadoLlamada> {
  const vinculo = vincularLlamadaConLead({ telefono: llamada.telefonoE164, email: llamada.email ?? null }, deps.leads);
  if (vinculo.estado === 'sin_lead') return { estado: 'sin_lead', motivo: vinculo.motivo };

  const transcripcion = enmascarar(llamada.transcripcion, [deps.nombreLead(vinculo.clickupTaskId) ?? '']);
  if (!transcripcion.trim()) return { estado: 'sin_conversacion' };

  const interaccionId = interaccionDe(llamada.llamadaId);
  // N-1.4: solo los leads antes de F2 generan decisión de pase. El modelo no recibe nunca la propuesta del SDR (decide por su cuenta).
  const conDecision = generaDecision(deps.etapaLead?.(vinculo.clickupTaskId) ?? null);
  let respuesta;
  let config: ContextoDecision | null = null;
  try {
    // Una sola lectura antes de llamar al modelo (no se retiene una conexión mientras contesta): el resumen que el lead tenía ANTES de
    // esta llamada (generación incremental, N-1.3) y el guion, el manual y los motivos vigentes (N-1.4).
    const previo = await deps.conDb(async (db) => ({
      resumenAnterior: await cargarResumenVigente(db, vinculo.clickupTaskId, llamada.ocurridaEn.toISOString()),
      config: await leerConfigDecision(db),
    }));
    config = previo.config;
    respuesta = await deps.evaluar(
      promptSistema(undefined, config ?? CONTEXTO_POR_DEFECTO),
      promptUsuario({
        interaccionId, direccion: llamada.direccion, fecha: fechaMadrid(llamada.ocurridaEn), duracionSegundos: llamada.duracionSegundos, transcripcion,
        resumenAnterior: previo.resumenAnterior, sinDecision: !conDecision,
      }),
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
      decision: conDecision && config
        ? { motivos: config.motivos, versionGuion: config.guion.version, versionManual: config.manual.version, versionPrompt: VERSION_PROMPT, origen: deps.origenDecision ?? 'nuevo' }
        : undefined,
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
    resumen: resultado.resumen,
    decision: resultado.decision,
    modelo: respuesta.model,
    tokens: [respuesta.inputTokens, respuesta.outputTokens],
    versionPrompt: VERSION_PROMPT,
  };
}
