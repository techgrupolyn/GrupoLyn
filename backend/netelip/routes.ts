// Receptor público de Netelip y API de lectura para la vista Netelip › Historial de llamadas.
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import type { Pool } from 'pg';
import { controlConfigFromEnv, isRecordingNotice, nextCommand, type CallState } from './control.ts';
import { bodyFields, IgnoredEvent, InvalidEvent, ipAllowed, isInternal, NETELIP_TRUSTED_NETWORKS, parseWhatsAppCall, tokenMatches } from './events.ts';
import { maskPhone } from './phone.ts';
import { acceptInbox, parseCallRecording, type InboxKind } from './processing.ts';

type Dependencies = {
  pool: Pool;
  admin: RequestHandler;
  /** Rol del usuario autenticado (lo deja `admin` en la sesión). */
  role: (res: Response) => string;
  /** Avisa de que hay trabajo nuevo en la bandeja, para no esperar al siguiente ciclo. */
  kick: () => void;
  env?: NodeJS.ProcessEnv;
};

const CONTROL_STATE_TTL_MS = 3 * 3600_000;
// Quién ve Historial de llamadas (pedido de Alejandro Yepez, 14/10/2026). Debe coincidir con
// NETELIP_ACCESS_ROLES del frontend (frontend/src/ceo-dashboard/CeoLogin.jsx).
const DEFAULT_ACCESS_ROLES = 'superadmin,admin,employee:director,employee:director_general';
// P6: quién lee el texto. Mientras Producto no decida, los mismos roles que ven la sección.
const DEFAULT_READER_ROLES = DEFAULT_ACCESS_ROLES;

export const normalizeRole = (role: unknown) =>
  String(role || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[\s/-]+/g, '_');

const roleIn = (role: unknown, list: string) => list.split(',').map(normalizeRole).filter(Boolean).includes(normalizeRole(role));

/** Roles que ven la sección y usan la API de lectura. */
export function canAccessNetelipCalls(role: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return roleIn(role, String(env.NETELIP_ACCESS_ROLES || DEFAULT_ACCESS_ROLES));
}

/** P6: roles que leen el texto de las transcripciones (siempre dentro de los que ven la sección). */
export function canReadTranscripts(role: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return canAccessNetelipCalls(role, env) && roleIn(role, String(env.NETELIP_TRANSCRIPT_READER_ROLES || DEFAULT_READER_ROLES));
}

export function registerNetelipCalls(app: Express, deps: Dependencies): void {
  const { pool } = deps;
  const env = deps.env || process.env;
  // Sesión de administración del Dashboard y, además, un rol con acceso a llamadas.
  const access: RequestHandler = (req, res, next) => deps.admin(req, res, () => {
    if (!canAccessNetelipCalls(deps.role(res), env)) return res.status(403).json({ error: 'No tienes permisos para ver el historial de llamadas.' });
    next();
  });
  const fail = (res: Response, error: unknown) => {
    console.error('[netelip] Error en la API:', (error as Error).message);
    res.status((error as { code?: string }).code?.startsWith('22') ? 400 : 500).json({ error: 'No se pudo completar la operación. Inténtalo de nuevo.' });
  };

  // --- Receptor ---------------------------------------------------------------------------------
  // Fuera de /api: sin sesión del Dashboard. Defensa: IP de Netelip + token en la ruta. Responde en
  // cuanto el evento queda guardado en la bandeja; el procesado va en segundo plano.
  const controlCalls = new Map<string, { state: CallState; touched: number }>();
  const controlConfig = controlConfigFromEnv(env);

  app.post('/webhook/netelip/:token/:kind', express.raw({ type: () => true, limit: '2mb' }), async (req: Request, res: Response) => {
    const kind = String(req.params.kind);
    const networks = kind === 'whatsapp-call' ? String(env.NETELIP_WHATSAPP_TRUSTED_NETWORKS || '') : String(env.NETELIP_TRUSTED_NETWORKS || NETELIP_TRUSTED_NETWORKS);
    if (!ipAllowed(req.ip, networks)) {
      console.warn(JSON.stringify({ msg: 'netelip_rejected_ip', kind, source_ip: req.ip }));
      return res.status(403).type('text').send('');
    }
    // 404 y no 401: no se confirma que la ruta exista.
    if (!tokenMatches(String(req.params.token), String(env.NETELIP_WEBHOOK_TOKEN || ''))) return res.status(404).type('text').send('');

    // express.json (global) ya ha leído los cuerpos JSON; el resto llega como Buffer.
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : '', 'utf8');
    let fields: Record<string, unknown> | unknown[];
    try {
      fields = await bodyFields(raw, req.header('content-type'));
    } catch (error) {
      console.warn(JSON.stringify({ msg: 'netelip_unreadable_body', kind, content_type: req.header('content-type') || null, bytes: raw.length, error: (error as Error).message }));
      if (kind === 'control') return res.status(400).json({ error: 'cuerpo inválido' });
      return res.status(400).type('text').send('invalid event');
    }

    if (kind === 'control') return handleControl(fields as Record<string, unknown>, res);

    let inboxKind: InboxKind;
    let payload: unknown;
    try {
      if (kind === 'report') {
        inboxKind = 'report';
        payload = fields;
      } else if (kind === 'whatsapp-call') {
        inboxKind = 'whatsapp_call';
        payload = parseWhatsAppCall(fields);
      } else if (kind === 'callrecording') {
        const event = parseCallRecording(fields);
        if (isInternal(event)) return res.status(200).type('text').send('ignored');
        inboxKind = 'callrecording';
        payload = event;
      } else {
        return res.status(404).type('text').send('');
      }
    } catch (error) {
      if (error instanceof IgnoredEvent) {
        console.log(JSON.stringify({ msg: 'netelip_event_ignored', index: error.index, status: error.status }));
        return res.status(200).type('text').send('ignored');
      }
      if (error instanceof InvalidEvent) {
        console.warn(JSON.stringify({ msg: 'netelip_invalid_event', kind, error: error.message }));
        return res.status(400).type('text').send('invalid event');
      }
      console.error('[netelip] Error validando el evento:', (error as Error).message);
      return res.status(500).type('text').send('');
    }
    try {
      const id = await acceptInbox(pool, inboxKind, payload);
      // Sin teléfonos ni URL en el log: son datos personales y tokens.
      console.log(JSON.stringify({ msg: 'netelip_event_accepted', kind: inboxKind, inbox_id: id }));
      deps.kick();
      return res.status(200).type('text').send('ok');
    } catch (error) {
      // Sin confirmación: Netelip puede reintentar y la conciliación recupera lo que falte.
      console.error('[netelip] No se pudo guardar el evento:', (error as Error).message);
      return res.status(500).type('text').send('');
    }
  });

  // Locución del aviso para las salientes: API Voice la descarga por `announce` (remote|<URL>).
  // Mismo control de IP y token que el receptor. NETELIP_AVISO_FILE apunta al MP3 en el servidor.
  app.get('/webhook/netelip/:token/aviso.mp3', (req: Request, res: Response) => {
    if (!ipAllowed(req.ip, String(env.NETELIP_TRUSTED_NETWORKS || NETELIP_TRUSTED_NETWORKS))) return res.status(403).end();
    if (!tokenMatches(String(req.params.token), String(env.NETELIP_WEBHOOK_TOKEN || '')) || !env.NETELIP_AVISO_FILE) return res.status(404).end();
    res.type('audio/mpeg').sendFile(String(env.NETELIP_AVISO_FILE), (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  });

  /** URL de control de API Voice: el estado de cada llamada vive en memoria (un solo proceso). */
  async function handleControl(req: Record<string, unknown>, res: Response) {
    const now = Date.now();
    for (const [id, entry] of controlCalls) if (now - entry.touched > CONTROL_STATE_TTL_MS) controlCalls.delete(id);
    const callId = String(req.ID || req.uniqueid || 'sin-id');
    const entry = controlCalls.get(callId) || { state: {}, touched: now };
    entry.touched = now;
    controlCalls.set(callId, entry);
    const { response, event } = nextCommand(req, entry.state, controlConfig);
    // Traza sin datos personales: solo el ID de Netelip, comandos y teléfonos enmascarados.
    console.log(JSON.stringify({
      msg: 'netelip_control', id: callId, src: maskPhone(String(req.src || '')), dst: maskPhone(String(req.dst || '')),
      prev: req.command || null, prev_status: req.statuscode || req.description || null, statuscall: req.statuscall || null,
      next: response.command, step: response.userfield, options: response.command === 'record' ? response.options : undefined, recording: Boolean(entry.state.recording),
      // Para el spike: qué campos envía Netelip y qué trae `description` (ruta en vDrive o estado del dial).
      notice_status: isRecordingNotice(req) ? req.status || null : undefined, fields: Object.keys(req).sort(), description: /^\+?\d{6,}$/.test(String(req.description || '')) ? maskPhone(String(req.description)) : req.description || null,
      talked: req.durationcallanswered ?? null, has_file: Boolean(entry.state.file), has_url_download: Boolean(req.URLDownload || entry.state.url_download),
      event: event ? 'generado' : null,
    }));
    // El estado se conserva tras colgar: el aviso con el fichero grabado llega después (lo limpia el TTL).
    if (event) controlCalls.delete(callId);
    if (event) {
      try {
        await acceptInbox(pool, 'callrecording', event);
        deps.kick();
      } catch (error) {
        console.error('[netelip] No se pudo guardar la grabación de API Voice:', (error as Error).message);
      }
    }
    return res.status(200).json(response);
  }

  // --- API de lectura (sesión del Dashboard; solo dirección y administración) ------------------

  const CALL_SELECT = `
    SELECT c.id, c.external_id, c.via, c.direction, c.occurred_at, c.contact_status, c.duration_seconds, c.call_status,
           CASE WHEN c.contact_status = 'hidden' THEN NULL ELSE COALESCE(c.phone_e164, c.counterpart_phone) END AS phone,
           c.client_id, c.lead_id::text AS lead_id,
           NULLIF(CONCAT_WS(' ', cl.nombre, cl.apellido), '') AS client_name, l.name AS lead_name,
           c.agent_extension, COALESCE(NULLIF(CONCAT_WS(' ', e.nombre, e.apellido), ''), x.label) AS agent_name,
           CASE t.status WHEN 'processing' THEN 'pending' ELSE t.status END AS transcription_status,
           t.status = 'processing' AS transcribing, t.progress AS transcription_progress
    FROM netelip_calls c
    LEFT JOIN clientes cl ON cl.id = c.client_id
    LEFT JOIN crm_leads l ON l.id = c.lead_id
    LEFT JOIN netelip_extensions x ON x.extension = c.agent_extension
    LEFT JOIN empleados e ON e.id = x.empleado_id
    LEFT JOIN netelip_call_transcriptions t ON t.call_id = c.id`;

  type CallRow = Record<string, unknown> & { client_id: string | null; lead_id: string | null; client_name: string | null; lead_name: string | null; agent_extension: string | null; agent_name: string | null };
  const toItem = (row: CallRow) => ({
    id: Number(row.id), external_id: row.external_id, via: row.via, direction: row.direction, occurred_at: row.occurred_at,
    phone: row.phone, contact_status: row.contact_status,
    contact: row.client_id ? { type: 'client', id: row.client_id, name: row.client_name || '' }
      : row.lead_id ? { type: 'lead', id: row.lead_id, name: row.lead_name || '' } : null,
    agent: row.agent_extension ? { extension: row.agent_extension, name: row.agent_name || null } : null,
    duration_seconds: row.duration_seconds, call_status: row.call_status, transcription_status: row.transcription_status || null,
    // Dentro de «pending»: en cola o transcribiendo, con su avance (0-100).
    transcription_phase: row.transcription_status === 'pending' ? (row.transcribing ? 'processing' : 'queued') : null,
    transcription_progress: row.transcribing && row.transcription_progress !== null ? Number(row.transcription_progress) : null,
  });

  app.get('/api/netelip/calls', access, async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(1, Math.trunc(Number(q.page)) || 1);
    const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(q.page_size)) || 25));
    // Filtros de periodo y vista (también para los indicadores) y filtros propios de la tabla.
    const base: string[] = [];
    const params: unknown[] = [];
    const add = (list: string[], sql: string, value: unknown) => { params.push(value); list.push(sql.replaceAll('?', `$${params.length}`)); };
    if (q.from) add(base, 'c.occurred_at >= ?::timestamptz', q.from);
    if (q.to) add(base, 'c.occurred_at < ?::timestamptz', q.to);
    if (q.direction === 'inbound' || q.direction === 'outbound') add(base, 'c.direction = ?', q.direction);
    if (q.via === 'phone' || q.via === 'whatsapp') add(base, 'c.via = ?', q.via);
    if (q.agent) add(base, 'c.agent_extension = ?', q.agent);
    const search = String(q.q || '').trim();
    if (search) {
      const digits = search.replace(/\D/g, '');
      params.push(`%${search}%`);
      const name = `$${params.length}`;
      let phone = 'FALSE';
      if (digits.length >= 3) { params.push(`%${digits}%`); phone = `c.phone_e164 LIKE $${params.length}`; }
      base.push(`(CONCAT_WS(' ', cl.nombre, cl.apellido) ILIKE ${name} OR l.name ILIKE ${name} OR ${phone})`);
    }
    const table = [...base];
    if (q.contact === 'identified') table.push("c.contact_status = 'matched'");
    if (q.contact === 'unidentified') table.push("c.contact_status <> 'matched'");
    if (q.contact_status && ['matched', 'unknown', 'hidden', 'multiple'].includes(q.contact_status)) add(table, 'c.contact_status = ?', q.contact_status);
    if (q.transcription === 'pending') table.push("t.status IN ('pending','processing')");
    else if (q.transcription === 'completed' || q.transcription === 'failed') add(table, 't.status = ?', q.transcription);
    else if (q.transcription === 'none') table.push('t.call_id IS NULL');
    const where = (list: string[]) => (list.length ? `WHERE ${list.join(' AND ')}` : '');
    const order = q.sort === 'occurred_at_asc' ? 'c.occurred_at ASC, c.id ASC' : q.sort === 'duration_desc' ? 'c.duration_seconds DESC, c.id DESC' : 'c.occurred_at DESC, c.id DESC';
    try {
      const joins = `FROM netelip_calls c LEFT JOIN clientes cl ON cl.id = c.client_id LEFT JOIN crm_leads l ON l.id = c.lead_id
        LEFT JOIN netelip_call_transcriptions t ON t.call_id = c.id`;
      const [rows, total, metrics] = await Promise.all([
        pool.query<CallRow>(`${CALL_SELECT} ${where(table)} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params),
        pool.query<{ total: string }>(`SELECT COUNT(*) AS total ${joins} ${where(table)}`, params),
        pool.query<Record<string, string>>(`SELECT COUNT(*) AS calls,
            COUNT(*) FILTER (WHERE c.contact_status <> 'matched') AS unidentified,
            COUNT(*) FILTER (WHERE t.status IN ('pending','processing')) AS transcription_pending,
            COUNT(*) FILTER (WHERE t.status = 'failed') AS transcription_failed
          ${joins} ${where(base)}`, params),
      ]);
      const count = Number(total.rows[0].total);
      const m = metrics.rows[0];
      res.json({
        items: rows.rows.map(toItem), page, pageSize, total: count, totalPages: Math.max(1, Math.ceil(count / pageSize)),
        metrics: { calls: Number(m.calls), unidentified: Number(m.unidentified), transcription_pending: Number(m.transcription_pending), transcription_failed: Number(m.transcription_failed) },
        can_read_transcripts: canReadTranscripts(deps.role(res), env),
      });
    } catch (error) { fail(res, error); }
  });

  app.get('/api/netelip/calls/filter-options', access, async (_req, res) => {
    try {
      const { rows } = await pool.query(`SELECT c.agent_extension AS extension, COALESCE(NULLIF(CONCAT_WS(' ', e.nombre, e.apellido), ''), x.label) AS name
        FROM (SELECT DISTINCT agent_extension FROM netelip_calls WHERE agent_extension IS NOT NULL) c
        LEFT JOIN netelip_extensions x ON x.extension = c.agent_extension LEFT JOIN empleados e ON e.id = x.empleado_id
        ORDER BY c.agent_extension`);
      res.json({ agents: rows });
    } catch (error) { fail(res, error); }
  });

  const readTranscription = async (id: number) => (await pool.query(
    `SELECT CASE status WHEN 'processing' THEN 'pending' ELSE status END AS status, engine, language, text, segments, completed_at
     FROM netelip_call_transcriptions WHERE call_id = $1`, [id])).rows[0] || null;

  app.get('/api/netelip/calls/:id', access, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Identificador de llamada no válido.' });
    try {
      const { rows } = await pool.query<CallRow>(`${CALL_SELECT} WHERE c.id = $1`, [id]);
      if (!rows.length) return res.status(404).json({ error: 'La llamada no existe.' });
      const allowed = canReadTranscripts(deps.role(res), env);
      const transcription = await readTranscription(id);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        call: toItem(rows[0]),
        transcription_access: allowed ? 'granted' : 'denied',
        // Sin permiso solo se informa del estado: el texto no sale del servidor.
        transcription: transcription ? (allowed ? transcription : { status: transcription.status }) : null,
      });
    } catch (error) { fail(res, error); }
  });

  app.get('/api/netelip/calls/:id/transcription', access, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Identificador de llamada no válido.' });
    if (!canReadTranscripts(deps.role(res), env)) return res.status(403).json({ error: 'No tienes permiso para leer transcripciones.' });
    try {
      const transcription = await readTranscription(id);
      if (!transcription) return res.status(404).json({ error: 'No hay transcripción para esta llamada.' });
      res.setHeader('Cache-Control', 'no-store');
      res.json(transcription);
    } catch (error) { fail(res, error); }
  });

  /** Teléfonos pendientes de resolución: llamadas sin lead ni cliente, o con varias coincidencias. */
  app.get('/api/netelip/unresolved-phones', access, async (_req, res) => {
    try {
      const { rows } = await pool.query(`SELECT phone_e164 AS phone, contact_status, COUNT(*)::int AS calls, MAX(occurred_at) AS last_call_at
        FROM netelip_calls WHERE phone_e164 IS NOT NULL AND contact_status IN ('unknown','multiple')
        GROUP BY phone_e164, contact_status ORDER BY last_call_at DESC LIMIT 500`);
      res.json(rows);
    } catch (error) { fail(res, error); }
  });

  app.put('/api/netelip/extensions/:extension', access, async (req, res) => {
    const extension = String(req.params.extension).trim();
    if (!/^\d{1,6}$/.test(extension)) return res.status(400).json({ error: 'Extensión no válida.' });
    const empleadoId = req.body?.empleado_id ? String(req.body.empleado_id) : null;
    const label = req.body?.label ? String(req.body.label).trim().slice(0, 120) : null;
    try {
      if (empleadoId && !(await pool.query('SELECT 1 FROM empleados WHERE id = $1', [empleadoId])).rowCount) return res.status(400).json({ error: 'El empleado no existe.' });
      const { rows } = await pool.query(
        `INSERT INTO netelip_extensions (extension, empleado_id, label) VALUES ($1, $2, $3)
         ON CONFLICT (extension) DO UPDATE SET empleado_id = EXCLUDED.empleado_id, label = EXCLUDED.label, updated_at = NOW() RETURNING *`,
        [extension, empleadoId, label],
      );
      res.json(rows[0]);
    } catch (error) { fail(res, error); }
  });
}
