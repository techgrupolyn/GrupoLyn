// API oficial de WhatsApp Business (Cloud API de Meta): envío de la plantilla aprobada y lectura de los webhooks de
// estado (sent / delivered / read / failed). La conversación la inicia LYN, así que solo vale una plantilla.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConfigCaptacion } from './config.ts';

type ConfigCloud = NonNullable<ConfigCaptacion['cloud']>;

export class ErrorCloud extends Error {
  constructor(message: string, readonly reintentable: boolean, readonly codigo: string | null) { super(message); }
}

// Códigos de error de Meta que son temporales: límites de envío, servicio no disponible, error desconocido y token
// caducado o sin permisos (190, 10, 200: se arregla en configuración; mejor reintentar que perder el aviso).
const CODIGOS_TEMPORALES = new Set(['1', '2', '4', '10', '17', '80007', '130429', '131000', '131016', '190', '200']);

/**
 * Envía la plantilla al lead desde el número `numeroId` (phone_number_id de la Cloud API). `parametros`: valores de
 * {{1}}, {{2}}… del cuerpo, en orden; vacío = plantilla sin variables.
 */
export type Enviar = (telefonoE164: string, numeroId: string, parametros?: string[]) => Promise<{ wamid: string }>;

type ConfigEnvio = Pick<ConfigCloud, 'token' | 'versionApi' | 'plantilla' | 'idioma'>;

export function crearEnviador(cloud: ConfigEnvio, fetcher: typeof fetch = fetch): Enviar {
  return async (telefonoE164, numeroId, parametros = []) => {
    const url = `https://graph.facebook.com/${encodeURIComponent(cloud.versionApi)}/${encodeURIComponent(numeroId)}/messages`;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cloud.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: telefonoE164.replace(/\D/g, ''),
          type: 'template',
          template: {
            name: cloud.plantilla,
            language: { code: cloud.idioma },
            ...(parametros.length ? { components: [{ type: 'body', parameters: parametros.map((text) => ({ type: 'text', text })) }] } : {}),
          },
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new ErrorCloud(`La API de WhatsApp no responde: ${(error as Error).message}`, true, null);
    }
    const cuerpo = await response.json().catch(() => ({})) as { messages?: { id?: string }[]; error?: { code?: number; message?: string; error_data?: { details?: string } } };
    if (response.ok && cuerpo.messages?.[0]?.id) return { wamid: cuerpo.messages[0].id };
    const codigo = cuerpo.error?.code !== undefined ? String(cuerpo.error.code) : null;
    const detalle = [cuerpo.error?.message, cuerpo.error?.error_data?.details].filter(Boolean).join(' · ').slice(0, 300);
    const reintentable = response.status >= 500 || response.status === 429 || (codigo !== null && CODIGOS_TEMPORALES.has(codigo));
    throw new ErrorCloud(`HTTP ${response.status}${codigo ? ` · código ${codigo}` : ''}${detalle ? ` · ${detalle}` : ''}`, reintentable, codigo);
  };
}

/** Meta firma el cuerpo crudo con el App Secret: X-Hub-Signature-256: sha256=<hex>. */
export function firmaMetaValida(cuerpo: Buffer, firma: string | undefined, appSecret: string): boolean {
  const hex = /^sha256=([0-9a-f]{64})$/i.exec(String(firma || '').trim())?.[1];
  if (!hex) return false;
  const esperada = createHmac('sha256', appSecret).update(cuerpo).digest();
  return timingSafeEqual(Buffer.from(hex, 'hex'), esperada);
}

export type EstadoMeta = { wamid: string; estado: 'sent' | 'delivered' | 'read' | 'failed'; fecha: Date; error: string | null };

/** Estados de mensaje de un webhook de la Cloud API. Los mensajes entrantes del lead se ignoran (fuera de alcance). */
export function estadosDelWebhook(body: unknown): EstadoMeta[] {
  const estados: EstadoMeta[] = [];
  const entradas = (body as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entradas)) return estados;
  for (const entrada of entradas) {
    for (const cambio of (entrada as { changes?: unknown[] })?.changes ?? []) {
      const statuses = (cambio as { value?: { statuses?: unknown[] } })?.value?.statuses ?? [];
      for (const s of statuses as { id?: string; status?: string; timestamp?: string; errors?: { code?: number; title?: string; message?: string }[] }[]) {
        if (!s?.id || !['sent', 'delivered', 'read', 'failed'].includes(String(s.status))) continue;
        const segundos = Number(s.timestamp);
        const e = s.errors?.[0];
        estados.push({
          wamid: s.id,
          estado: s.status as EstadoMeta['estado'],
          fecha: Number.isFinite(segundos) && segundos > 0 ? new Date(segundos * 1000) : new Date(),
          error: e ? `código ${e.code ?? '?'} · ${e.title || e.message || 'sin detalle'}`.slice(0, 300) : null,
        });
      }
    }
  }
  return estados;
}
