// Ruta pública del webhook de ClickUp de la captación ABCD. Va FUERA de /api (sin sesión del Dashboard) y ANTES del
// `express.json` global: la firma se calcula sobre los bytes exactos del cuerpo, no sobre el JSON ya interpretado.
// Apagada por defecto: sin `CAPTACION_WEBHOOK_ENABLED=true` la ruta no existe (404).
import express, { type Express, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { ClickUpClient, clickupConfigDesdeEnv } from './clickup.ts';
import { firmaValida, leerEvento, ProcesadorWebhook, type DependenciasWebhook } from './webhook.ts';

export const RUTA_WEBHOOK_CAPTACION = '/webhook/clickup/captacion';

export interface ConfigWebhook {
  secreto: string;
  /** Opcional: si no se informa, es el dueño del token de ClickUp. */
  usuarioIntegracionId?: string;
}

/** Null (y el motivo) si el webhook no está activado o le falta algo. */
export function configWebhookDesdeEnv(env: NodeJS.ProcessEnv = process.env): { config: ConfigWebhook } | { apagado: string } {
  if (env.CAPTACION_WEBHOOK_ENABLED !== 'true') return { apagado: 'CAPTACION_WEBHOOK_ENABLED no es true' };
  const secreto = env.CAPTACION_WEBHOOK_SECRET?.trim();
  if (!secreto) return { apagado: 'falta CAPTACION_WEBHOOK_SECRET' };
  if (!clickupConfigDesdeEnv(env)) return { apagado: 'faltan CLICKUP_API_TOKEN o CAPTACION_CLICKUP_LIST_ID' };
  const usuario = env.CAPTACION_INTEGRATION_USER_ID?.trim();
  return { config: { secreto, ...(usuario ? { usuarioIntegracionId: usuario } : {}) } };
}

export function registrarWebhookCaptacion(
  app: Pick<Express, 'post'>,
  procesador: Pick<ProcesadorWebhook, 'encolar'>,
  secreto: string,
  registro: (linea: Record<string, unknown>) => void = (l) => console.log(JSON.stringify(l)),
): void {
  app.post(RUTA_WEBHOOK_CAPTACION, express.raw({ type: () => true, limit: '1mb' }), (req: Request, res: Response) => {
    const cuerpo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!firmaValida(cuerpo, req.header('x-signature'), secreto)) {
      registro({ msg: 'captacion_webhook_firma_invalida', source_ip: req.ip });
      return res.status(401).type('text').send('');
    }
    const evento = leerEvento(cuerpo);
    if (!evento) return res.status(400).type('text').send('');
    // Se responde ya: ClickUp reintenta y acaba desactivando el webhook si tarda. El trabajo sigue en segundo plano.
    res.status(200).json({ ok: true });
    procesador.encolar(evento).then(
      (r) => registro({ msg: 'captacion_webhook', tarea: evento.tareaId, evento: evento.evento, ...r }),
      (error: Error) => registro({ msg: 'captacion_webhook_error', tarea: evento.tareaId, error: error.name, detalle: error.message }),
    );
  });
}

/** Lo que usa `server.ts`: lee el entorno, y si está activado crea el cliente, el procesador y la ruta. */
export function iniciarWebhookCaptacion(app: Express, pool: Pool, env: NodeJS.ProcessEnv = process.env): void {
  const c = configWebhookDesdeEnv(env);
  if ('apagado' in c) {
    if (env.CAPTACION_WEBHOOK_ENABLED === 'true') console.warn(`[captacion] webhook apagado: ${c.apagado}`);
    return;
  }
  const cfg = clickupConfigDesdeEnv(env)!;
  const deps: DependenciasWebhook = {
    conexion: () => pool.connect(),
    clickup: new ClickUpClient(cfg),
    ...(c.config.usuarioIntegracionId ? { usuarioIntegracionId: c.config.usuarioIntegracionId } : {}),
  };
  registrarWebhookCaptacion(app, new ProcesadorWebhook(deps), c.config.secreto);
  console.log(`[captacion] webhook de ClickUp activo en ${RUTA_WEBHOOK_CAPTACION}`);
}
