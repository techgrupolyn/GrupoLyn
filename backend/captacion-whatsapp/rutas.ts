// Receptores públicos (webhooks de ClickUp y de la Cloud API de Meta) y API de lectura del historial de avisos.
// Los receptores van fuera de /api (sin sesión del Dashboard) y antes de express.json: la firma se comprueba sobre
// el cuerpo crudo. Sin secreto configurado no se acepta nada (503): nunca un receptor abierto.
import express, { type Express, type Request, type RequestHandler, type Response, type Router } from 'express';
import type { Pool } from 'pg';
import { firmaClickUpValida } from './clickup.ts';
import { estadosDelWebhook, firmaMetaValida } from './cloud-api.ts';
import type { ConfigCaptacion } from './config.ts';
import { aceptarWebhookClickUp, aplicarEstados } from './proceso.ts';

const crudo = express.raw({ type: () => true, limit: '1mb' });

function json(req: Request): unknown {
  try {
    return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');
  } catch {
    return null;
  }
}

export function crearRouterWebhooks(pool: Pick<Pool, 'query'>, config: ConfigCaptacion | null, kick: () => void): Router {
  const router = express.Router();

  router.post('/webhook/captacion/clickup', crudo, async (req, res) => {
    if (!config) return res.status(404).end();
    if (!config.clickup.webhookSecret) return res.status(503).end();
    if (!firmaClickUpValida(req.body as Buffer, req.get('x-signature'), config.clickup.webhookSecret)) {
      console.warn(JSON.stringify({ msg: 'captacion_clickup_firma_invalida', source_ip: req.ip }));
      return res.status(401).end();
    }
    const payload = json(req);
    if (!payload || typeof payload !== 'object') return res.status(400).end();
    try {
      await aceptarWebhookClickUp(pool, payload);
      kick();
      res.status(200).end();
    } catch (error) {
      console.error('[captacion] No se pudo guardar el webhook de ClickUp:', (error as Error).message);
      res.status(500).end();   // ClickUp reintenta
    }
  });

  // Verificación del webhook al darlo de alta en Meta.
  router.get('/webhook/whatsapp-cloud', (req, res) => {
    const verifyToken = config?.cloud?.verifyToken;
    if (!verifyToken) return res.status(404).end();
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) {
      return res.status(200).type('text').send(String(req.query['hub.challenge'] ?? ''));
    }
    res.status(403).end();
  });

  router.post('/webhook/whatsapp-cloud', crudo, async (req, res) => {
    const appSecret = config?.cloud?.appSecret;
    if (!config?.cloud) return res.status(404).end();
    if (!appSecret) return res.status(503).end();
    if (!firmaMetaValida(req.body as Buffer, req.get('x-hub-signature-256'), appSecret)) {
      console.warn(JSON.stringify({ msg: 'captacion_meta_firma_invalida', source_ip: req.ip }));
      return res.status(401).end();
    }
    try {
      await aplicarEstados(pool, estadosDelWebhook(json(req)));
      res.status(200).end();
    } catch (error) {
      console.error('[captacion] No se pudo aplicar el estado de Meta:', (error as Error).message);
      res.status(500).end();   // Meta reintenta
    }
  });

  return router;
}

const COLUMNAS = `id, solicitud, clickup_task_id, origen, entrada_en, lead_nombre, telefono_e164, presupuesto, remitente, estado, motivo, plantilla,
  intentos, creado_en, enviado_en, entregado_en, leido_en, fallido_en, actualizado_en`;

/** Historial de avisos: por lead (?clickup_task_id=) o los últimos. Solo con sesión de administración. */
export function registrarApiCaptacion(app: Express, deps: { pool: Pick<Pool, 'query'>; admin: RequestHandler }): void {
  app.get('/api/captacion/whatsapp/avisos', deps.admin, async (req: Request, res: Response) => {
    const taskId = typeof req.query.clickup_task_id === 'string' ? req.query.clickup_task_id.trim() : '';
    const limite = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    try {
      const { rows } = taskId
        ? await deps.pool.query(`SELECT ${COLUMNAS} FROM captacion_whatsapp_avisos WHERE clickup_task_id = $1 ORDER BY creado_en DESC LIMIT $2`, [taskId, limite])
        : await deps.pool.query(`SELECT ${COLUMNAS} FROM captacion_whatsapp_avisos ORDER BY creado_en DESC LIMIT $1`, [limite]);
      res.json({ avisos: rows.map((r) => ({ ...r, canal: 'whatsapp', tipo: 'aviso_llamada' })) });
    } catch (error) {
      console.error('[captacion] Error en la API:', (error as Error).message);
      res.status(500).json({ error: 'No se pudo cargar el historial de avisos.' });
    }
  });
}
