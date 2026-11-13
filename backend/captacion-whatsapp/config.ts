// Configuración del aviso por WhatsApp cuando un lead entra en «e1 EN ESPERA» (Captación). Ver
// docs/CAPTACION_WHATSAPP_ESPERA.md. Todo sale de variables de entorno; sin CAPTACION_WHATSAPP_ENABLED=true no
// arranca nada (ni webhooks, ni barrido, ni envíos), para que desplegar el código no escriba nunca a un lead.
import { LISTA_CONTACTO_REFORMA } from '../reuniones-meet/clickup.ts';

export type ConfigCaptacion = {
  clickup: {
    token: string;
    lista: string;
    campoEtapa: string;          // ETAPA_CRM
    etapaEspera: string;         // «e1 EN ESPERA»
    campoTelefono: string;       // contact_phone_number
    webhookSecret: string | null;
  };
  cloud: {
    token: string;
    phoneNumberId: string;
    versionApi: string;
    plantilla: string;
    idioma: string;
    appSecret: string | null;    // firma de los webhooks de estado (X-Hub-Signature-256)
    verifyToken: string | null;  // verificación GET del webhook en Meta
  } | null;
  /** Franja de envío en hora de Madrid, en minutos desde medianoche; null = siempre. */
  horario: { desde: number; hasta: number } | null;
  /** Un aviso más antiguo que esto ya no se envía («te llamará en breve» no sirve horas después). */
  caducidadMinutos: number;
};

const minutos = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) throw new Error(`Hora no válida: «${hhmm}» (formato HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** «09:00-21:00» → minutos. Vacío = sin restricción. Si desde > hasta, la franja cruza la medianoche. */
export function parseHorario(raw: string | undefined): ConfigCaptacion['horario'] {
  const valor = String(raw || '').trim();
  if (!valor) return null;
  const partes = valor.split('-');
  if (partes.length !== 2) throw new Error(`CAPTACION_WHATSAPP_HORARIO no válido: «${valor}» (formato 09:00-21:00)`);
  return { desde: minutos(partes[0]), hasta: minutos(partes[1]) };
}

/** null si el módulo está apagado o le falta lo mínimo (token de ClickUp). */
export function configCaptacionDesdeEnv(env: NodeJS.ProcessEnv = process.env): ConfigCaptacion | null {
  if (env.CAPTACION_WHATSAPP_ENABLED !== 'true') return null;
  const token = env.CLICKUP_API_TOKEN?.trim();
  if (!token) return null;
  const cloudToken = env.WHATSAPP_CLOUD_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_CLOUD_PHONE_NUMBER_ID?.trim();
  const plantilla = env.CAPTACION_WHATSAPP_PLANTILLA?.trim();
  const caducidad = Number(env.CAPTACION_WHATSAPP_CADUCIDAD_MINUTOS || 720);
  if (!Number.isInteger(caducidad) || caducidad < 1) throw new Error('CAPTACION_WHATSAPP_CADUCIDAD_MINUTOS debe ser un entero >= 1');
  return {
    clickup: {
      token,
      lista: env.CAPTACION_CLICKUP_LISTA?.trim() || LISTA_CONTACTO_REFORMA,
      campoEtapa: env.CAPTACION_CLICKUP_CAMPO_ETAPA?.trim() || 'ETAPA_CRM',
      etapaEspera: env.CAPTACION_CLICKUP_ETAPA_ESPERA?.trim() || 'e1 EN ESPERA',
      campoTelefono: env.CAPTACION_CLICKUP_CAMPO_TELEFONO?.trim() || 'contact_phone_number',
      webhookSecret: env.CAPTACION_CLICKUP_WEBHOOK_SECRET?.trim() || null,
    },
    cloud: cloudToken && phoneNumberId && plantilla ? {
      token: cloudToken,
      phoneNumberId,
      versionApi: env.WHATSAPP_CLOUD_API_VERSION?.trim() || 'v23.0',
      plantilla,
      idioma: env.CAPTACION_WHATSAPP_IDIOMA?.trim() || 'es_ES',
      appSecret: env.WHATSAPP_CLOUD_APP_SECRET?.trim() || null,
      verifyToken: env.WHATSAPP_CLOUD_VERIFY_TOKEN?.trim() || null,
    } : null,
    horario: parseHorario(env.CAPTACION_WHATSAPP_HORARIO),
    caducidadMinutos: caducidad,
  };
}

/** Minutos desde medianoche en Madrid. */
export function minutoMadrid(fecha: Date): number {
  const partes = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(fecha);
  const valor = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value || 0);
  return valor('hour') * 60 + valor('minute');
}

export function dentroDeHorario(horario: ConfigCaptacion['horario'], fecha: Date): boolean {
  if (!horario) return true;
  const m = minutoMadrid(fecha);
  return horario.desde <= horario.hasta ? m >= horario.desde && m < horario.hasta : m >= horario.desde || m < horario.hasta;
}
