import type { Express, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { EntradaInvalida, validarEntradaDecision, type MotivosPorDecision } from './decision.ts';
import {
  acierto, bandeja, CasoNoEncontrado, CasoYaRevisado, cargarMotivos, confirmarCaso, corregirCaso, detalleCaso, LlamadaSinLead, llamadaIdDe,
  registrarPropuestaSDR, vistaParaSDR, YaRegistrada, type DetalleCaso, type FilaDecision, type VistaSDR,
} from './decision-repositorio.ts';
import type { Db } from './repositorio.ts';
import { canSupervise } from '../calificador/rutas.ts';

// N-1.4 · API de la decisión de pase: formulario del SDR en el detalle de la llamada, bandeja de Ernesto, confirmar/corregir y acierto.
// El SDR no ve la decisión de la IA hasta registrar la suya (se hace aquí, en el servidor, no en la pantalla).

type Deps = {
  pool: Pool;
  /** Sesión del Dashboard con acceso a Historial de llamadas. */
  access: RequestHandler;
  role: (res: Response) => string;
  /** Quién escribe: id y nombre para el rastro de cada propuesta. */
  actor?: (res: Response) => { id: string; nombre: string };
  fail: (res: Response, error: unknown) => void;
  canReadTranscripts: (role: unknown) => boolean;
  env: NodeJS.ProcessEnv;
  /** Tras revisar un caso (confirmar o corregir): refleja la decisión final en la tarjeta. Si falla, la revisión ya está guardada. */
  alRevisar?: (leadId: string) => Promise<unknown>;
};

const normalizar = (role: unknown) =>
  String(role || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[\s/-]+/g, '_');

/**
 * Quién valida casos (la bandeja de Ernesto y el acierto). Por defecto, los mismos roles que supervisan el calificador; se puede
 * cambiar con CAPTACION_DECISION_VALIDADORES (roles separados por comas) sin tocar código.
 */
export function puedeValidarDecisiones(role: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const lista = String(env.CAPTACION_DECISION_VALIDADORES || '').split(',').map(normalizar).filter(Boolean);
  return lista.length > 0 ? lista.includes(normalizar(role)) : canSupervise(role, env);
}

const idLlamada = (raw: unknown): number | null => {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const dtoMotivos = (m: MotivosPorDecision) => m;

/** Sin permiso de leer transcripciones no salen las citas literales (mismo criterio que la evaluación del calificador). */
function dtoDecision(f: FilaDecision | null, conCitas: boolean) {
  if (!f) return null;
  return {
    actor: f.actor, decision: f.decision, motivo_codigo: f.motivoCodigo,
    // El dato o la cita suele ser una frase de la llamada (la de la IA siempre lo es): sin permiso de transcripciones no sale de ninguno de los
    // tres actores, ni el texto libre de un motivo «otro» de la IA.
    dato_cita: conCitas ? f.datoCita : null,
    motivo_texto: conCitas || f.actor !== 'ia' ? f.motivoTexto : null,
    motivos: conCitas ? f.motivos : (f.motivos as Array<{ codigo: string; texto: string | null }>).map(({ codigo, texto }) => ({ codigo, texto })),
    excepciones: f.excepciones, dudas: f.dudas, pendiente_ernesto: f.pendienteErnesto,
    proximos_pasos: conCitas ? f.proximosPasos : f.proximosPasos.map((p) => ({ ...p, cita: null })),
    version_guion: f.versionGuion, version_manual: f.versionManual, origen: f.origen, a_favor: f.aFavor,
    usuario_nombre: f.usuarioNombre, creado_en: f.creadoEn,
  };
}

const dtoVista = (v: VistaSDR, conCitas: boolean) => ({
  lead_conocido: v.leadConocido, motivos: dtoMotivos(v.motivos), estado: v.estado, sdr: dtoDecision(v.sdr, conCitas), ia: dtoDecision(v.ia, conCitas),
});

const dtoDetalle = (d: DetalleCaso, conCitas: boolean) => ({
  llamada_id: d.llamadaId, lead_id: d.leadId, estado: d.estado, motivo_escalado: d.motivoEscalado, coincide: d.coincide, revisado_por: d.revisadoPor, revisado_en: d.revisadoEn,
  sdr: dtoDecision(d.sdr, conCitas), ia: dtoDecision(d.ia, conCitas), ernesto: dtoDecision(d.ernesto, conCitas),
  resumen: d.resumen && { que_quiere: d.resumen.queQuiere, donde_quedo: d.resumen.dondeQuedo, que_lo_frena: d.resumen.queLoFrena, para_que_llamarlo: d.resumen.paraQueLlamarlo, fecha_prevista: d.resumen.fechaPrevista },
  calificacion: d.calificacion, motivos: dtoMotivos(d.motivos),
});

export function registerDecisionPase(app: Express, deps: Deps): void {
  const { pool, access, fail, env } = deps;
  const lector = pool as unknown as Db;
  const identidad = (res: Response) => deps.actor?.(res) || { id: 'desconocido', nombre: 'Desconocido' };
  const conCitas = (res: Response) => deps.canReadTranscripts(deps.role(res));

  /** Errores de negocio de esta API → su código HTTP; el resto, al manejador general. */
  const responderError = (res: Response, error: unknown): void => {
    if (error instanceof EntradaInvalida) { res.status(400).json({ error: error.message }); return; }
    if (error instanceof LlamadaSinLead || error instanceof YaRegistrada || error instanceof CasoYaRevisado) { res.status(409).json({ error: (error as Error).message }); return; }
    if (error instanceof CasoNoEncontrado) { res.status(404).json({ error: error.message }); return; }
    fail(res, error);
  };
  const soloValidadores = (res: Response): boolean => {
    if (puedeValidarDecisiones(deps.role(res), env)) return true;
    res.status(403).json({ error: 'No tienes permiso para validar decisiones de pase.' });
    return false;
  };
  const conConexion = async <T>(fn: (db: Db) => Promise<T>): Promise<T> => {
    const conexion = await pool.connect();
    try {
      return await fn(conexion as unknown as Db);
    } finally {
      conexion.release();
    }
  };

  // --- SDR: su propuesta en el detalle de la llamada -----------------------------------------------------------------------

  app.get('/api/netelip/calls/:id/decision', access, async (req, res) => {
    const id = idLlamada(req.params.id);
    if (!id) return res.status(400).json({ error: 'Identificador de llamada no válido.' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(dtoVista(await vistaParaSDR(lector, llamadaIdDe(id)), conCitas(res)));
    } catch (error) { fail(res, error); }
  });

  app.post('/api/netelip/calls/:id/decision', access, async (req, res) => {
    const id = idLlamada(req.params.id);
    if (!id) return res.status(400).json({ error: 'Identificador de llamada no válido.' });
    try {
      const entrada = validarEntradaDecision(req.body, await cargarMotivos(lector));
      const autor = identidad(res);
      await conConexion((db) => registrarPropuestaSDR(db, { llamadaId: llamadaIdDe(id), entrada, usuarioId: autor.id, usuarioNombre: autor.nombre }));
      // Ahora que el SDR ya decidió, ve la decisión de la IA y sus próximos pasos.
      res.status(201).json(dtoVista(await vistaParaSDR(lector, llamadaIdDe(id)), conCitas(res)));
    } catch (error) { responderError(res, error); }
  });

  // --- Ernesto: bandeja, caso, confirmar y corregir, acierto -----------------------------------------------------------------

  app.get('/api/captacion/decisiones/bandeja', access, async (req, res) => {
    if (!soloValidadores(res)) return;
    const q = req.query as Record<string, string | undefined>;
    const estado = q.estado === 'revisados' || q.estado === 'todos' ? q.estado : 'pendientes';
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ items: await bandeja(lector, { estado, limite: Number(q.limite) || undefined }) });
    } catch (error) { fail(res, error); }
  });

  app.get('/api/captacion/decisiones/acierto', access, async (_req, res) => {
    if (!soloValidadores(res)) return;
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ items: await acierto(lector) });
    } catch (error) { fail(res, error); }
  });

  app.get('/api/captacion/decisiones/llamada/:id', access, async (req, res) => {
    if (!soloValidadores(res)) return;
    const id = idLlamada(req.params.id);
    if (!id) return res.status(400).json({ error: 'Identificador de llamada no válido.' });
    try {
      const d = await detalleCaso(lector, llamadaIdDe(id));
      if (!d) return res.status(404).json({ error: 'No existe ese caso en la bandeja.' });
      res.setHeader('Cache-Control', 'no-store');
      res.json(dtoDetalle(d, conCitas(res)));
    } catch (error) { fail(res, error); }
  });

  const revisar = (accion: 'confirmar' | 'corregir'): RequestHandler => async (req, res) => {
    if (!soloValidadores(res)) return;
    const id = idLlamada(req.params.id);
    if (!id) return void res.status(400).json({ error: 'Identificador de llamada no válido.' });
    try {
      const autor = identidad(res);
      const revisor = { usuarioId: autor.id, usuarioNombre: autor.nombre };
      const llamadaId = llamadaIdDe(id);
      const body = (req.body || {}) as Record<string, unknown>;
      const fila = await conConexion((db) => accion === 'confirmar'
        ? confirmarCaso(db, { llamadaId, revisor, aFavor: typeof body.a_favor === 'string' ? body.a_favor : null })
        : corregirCaso(db, { llamadaId, revisor, entrada: body, proximosPasos: body.proximos_pasos }));
      // La revisión ya está guardada: reflejarla en la tarjeta es un extra que no debe tumbarla.
      if (deps.alRevisar) await deps.alRevisar(fila.leadId).catch((error: unknown) => console.warn('[captacion] decisión de pase: no se pudo reflejar en ClickUp:', (error as Error).message));
      const d = await detalleCaso(lector, llamadaId);
      res.status(200).json(d ? dtoDetalle(d, conCitas(res)) : { ok: true });
    } catch (error) { responderError(res, error); }
  };
  app.post('/api/captacion/decisiones/llamada/:id/confirmar', access, revisar('confirmar'));
  app.post('/api/captacion/decisiones/llamada/:id/corregir', access, revisar('corregir'));
}
