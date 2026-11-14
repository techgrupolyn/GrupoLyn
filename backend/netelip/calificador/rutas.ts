// API del calificador para el Dashboard: evaluación de una llamada, feedback del supervisor,
// objeciones e ideas de marketing, y alta de comerciales (extensión → rol).
import type { Express, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { toE164 } from '../phone.ts';
import { anadirFeedbackHumano, configDesdeEnv, type Enviador } from './proceso.ts';
import { ROLES_COMERCIALES, type RolComercial } from './schema.ts';
import { TIPOS_OBJECION } from './reglas.ts';

type Deps = {
  pool: Pool;
  /** Sesión del Dashboard con acceso a Historial de llamadas. */
  access: RequestHandler;
  role: (res: Response) => string;
  /** Quién escribe el feedback humano. */
  actor?: (res: Response) => { id: string; nombre: string };
  enviar?: Enviador | null;
  fail: (res: Response, error: unknown) => void;
  canReadTranscripts: (role: unknown) => boolean;
  env: NodeJS.ProcessEnv;
};

// Quién puede escribir feedback y dar de alta comerciales. Por defecto, los mismos roles que ven la sección.
const normalizeRole = (role: unknown) =>
  String(role || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[\s/-]+/g, '_');
const DEFAULT_SUPERVISOR_ROLES = 'superadmin,admin,employee:director,employee:director_general';

export function canSupervise(role: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.CALIFICADOR_SUPERVISOR_ROLES || DEFAULT_SUPERVISOR_ROLES).split(',').map(normalizeRole).filter(Boolean).includes(normalizeRole(role));
}

const idLlamada = (raw: unknown) => { const id = Number(raw); return Number.isSafeInteger(id) && id > 0 ? id : null; };

export function registerCalificador(app: Express, deps: Deps): void {
  const { pool, access, fail, env } = deps;
  const config = () => configDesdeEnv(env);

  // Evaluación de una llamada. Las citas salen de la transcripción (enmascarada): mismo permiso que leer el texto.
  app.get('/api/netelip/calls/:id/evaluacion', access, async (req, res) => {
    const id = idLlamada(req.params.id);
    if (!id) return res.status(400).json({ error: 'Identificador de llamada no válido.' });
    try {
      // Principal: la evaluación automática (la que recibió el comercial). Las reevaluaciones van en `otras`.
      const { rows: todas } = await pool.query(
        `SELECT e.id, e.estado, e.motivo_no_evaluada, e.nota, e.apto, e.errores_criticos, e.bien, e.mejorar, e.escalado, e.motivo_escalado,
                e.duda, e.motivo_duda, e.feedback_texto, e.version_rubrica, e.modelo, e.enviado_en, e.envio_error, e.creado_en, e.actualizado_en,
                e.rol, r.nombre AS comercial, e.puntuacion_pasos, e.sin_consentimiento, e.reevaluacion,
                v.codigo AS rubrica_codigo, v.fuente AS rubrica_fuente, v.errores_criticos AS rubrica_errores
         FROM llamada_evaluacion e LEFT JOIN comercial_rol r ON r.extension_netelip = e.extension_netelip
         LEFT JOIN rubrica_version v ON v.id = e.rubrica_version_id
         WHERE e.llamada_id = $1 ORDER BY e.reevaluacion, e.creado_en DESC`, [id]);
      res.setHeader('Cache-Control', 'no-store');
      const [principal, ...resto] = todas;
      if (!principal) return res.json({ evaluation: null, can_supervise: canSupervise(deps.role(res), env) });
      const { rubrica_codigo, rubrica_fuente, rubrica_errores, ...ev } = principal;
      ev.rubrica = rubrica_codigo ? { codigo: rubrica_codigo, fuente: rubrica_fuente, errores: (rubrica_errores || []).map(({ codigo, nombre }: { codigo: string; nombre: string }) => ({ codigo, nombre })) } : null;
      ev.otras = resto.map((o) => ({ id: o.id, estado: o.estado, nota: o.nota, apto: o.apto, version_rubrica: o.version_rubrica, reevaluacion: o.reevaluacion,
        sin_consentimiento: o.sin_consentimiento, errores_criticos: (o.errores_criticos || []).map(({ regla }: { regla: string }) => regla), creado_en: o.creado_en }));
      const allowed = deps.canReadTranscripts(deps.role(res));
      const [{ rows: feedback }, { rows: objeciones }] = await Promise.all([
        pool.query('SELECT id, autor_nombre, texto, enviado_en, envio_error, creado_en FROM llamada_feedback_humano WHERE evaluacion_id = $1 ORDER BY creado_en', [ev.id]),
        pool.query('SELECT id, tipo_objecion AS tipo, cita, idea_contenido FROM objecion_marketing WHERE evaluacion_id = $1 ORDER BY id', [ev.id]),
      ]);
      // Sin permiso de lectura de transcripciones: la nota y el resultado, sin citas literales.
      const errores = allowed ? ev.errores_criticos : (ev.errores_criticos as Array<{ regla: string; marca_tiempo: string }>).map(({ regla, marca_tiempo }) => ({ regla, marca_tiempo }));
      res.json({
        evaluation: { ...ev, errores_criticos: errores, objeciones: allowed ? objeciones : objeciones.map(({ id: oid, tipo }) => ({ id: oid, tipo })), feedback_humano: feedback },
        quotes_access: allowed ? 'granted' : 'denied',
        can_supervise: canSupervise(deps.role(res), env),
      });
    } catch (error) { fail(res, error); }
  });

  // Feedback del supervisor sobre una evaluación: queda junto al de la IA y se envía al comercial.
  app.post('/api/netelip/calls/:id/evaluacion/feedback', access, async (req, res) => {
    const id = idLlamada(req.params.id);
    if (!id) return res.status(400).json({ error: 'Identificador de llamada no válido.' });
    if (!canSupervise(deps.role(res), env)) return res.status(403).json({ error: 'No tienes permiso para añadir feedback a las evaluaciones.' });
    try {
      const autor = deps.actor?.(res) || { id: 'desconocido', nombre: config().supervisorNombre };
      const saved = await anadirFeedbackHumano(pool, id, autor, String(req.body?.texto || ''), deps.enviar || null, config());
      res.status(201).json(saved);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status) return res.status(status).json({ error: (error as Error).message });
      fail(res, error);
    }
  });

  // Objeciones e ideas de marketing, filtrables por tipo y fecha. Sin datos personales por diseño.
  app.get('/api/netelip/objeciones', access, async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
    if (q.tipo && (TIPOS_OBJECION as readonly string[]).includes(q.tipo)) add('o.tipo_objecion = ?', q.tipo);
    if (q.from) add('c.occurred_at >= ?::timestamptz', q.from);
    if (q.to) add('c.occurred_at < ?::timestamptz', q.to);
    if (q.ideas === '1') where.push('o.idea_contenido IS NOT NULL');
    try {
      const { rows } = await pool.query(
        `SELECT o.id, o.tipo_objecion AS tipo, o.cita, o.idea_contenido, o.llamada_id, c.occurred_at, e.rol
         FROM objecion_marketing o JOIN netelip_calls c ON c.id = o.llamada_id LEFT JOIN llamada_evaluacion e ON e.id = o.evaluacion_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.occurred_at DESC, o.id LIMIT 500`, params);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ items: rows });
    } catch (error) { fail(res, error); }
  });

  app.get('/api/netelip/comerciales', access, async (_req, res) => {
    try {
      const { rows } = await pool.query('SELECT extension_netelip, empleado_id, nombre, rol, whatsapp, activo, actualizado_en FROM comercial_rol ORDER BY extension_netelip');
      res.json({ items: rows, roles: ROLES_COMERCIALES });
    } catch (error) { fail(res, error); }
  });

  // Alta o cambio de un comercial evaluado. Sin fila activa, las llamadas de esa extensión no se evalúan.
  app.put('/api/netelip/comerciales/:extension', access, async (req, res) => {
    if (!canSupervise(deps.role(res), env)) return res.status(403).json({ error: 'No tienes permiso para configurar comerciales.' });
    const extension = String(req.params.extension).trim();
    if (!/^\d{1,6}$/.test(extension)) return res.status(400).json({ error: 'Extensión no válida.' });
    const body = (req.body || {}) as Record<string, unknown>;
    const nombre = String(body.nombre || '').trim().slice(0, 120);
    const rol = String(body.rol || '') as RolComercial;
    if (!nombre) return res.status(400).json({ error: 'Indica el nombre del comercial.' });
    if (!ROLES_COMERCIALES.includes(rol)) return res.status(400).json({ error: `Rol no válido: usa ${ROLES_COMERCIALES.join(', ')}.` });
    let whatsapp: string | null = null;
    if (body.whatsapp) {
      try { whatsapp = toE164(String(body.whatsapp)); } catch { return res.status(400).json({ error: 'El WhatsApp no es un teléfono válido.' }); }
    }
    const empleadoId = body.empleado_id ? String(body.empleado_id) : null;
    try {
      if (empleadoId && !(await pool.query('SELECT 1 FROM empleados WHERE id = $1', [empleadoId])).rowCount) return res.status(400).json({ error: 'El empleado no existe.' });
      const { rows: [row] } = await pool.query(
        `INSERT INTO comercial_rol (extension_netelip, empleado_id, nombre, rol, whatsapp, activo) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (extension_netelip) DO UPDATE SET empleado_id = EXCLUDED.empleado_id, nombre = EXCLUDED.nombre, rol = EXCLUDED.rol,
           whatsapp = EXCLUDED.whatsapp, activo = EXCLUDED.activo, actualizado_en = NOW() RETURNING *`,
        [extension, empleadoId, nombre, rol, whatsapp, body.activo !== false]);
      res.json(row);
    } catch (error) { fail(res, error); }
  });
}
