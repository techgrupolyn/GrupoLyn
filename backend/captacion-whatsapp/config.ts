// Configuración del aviso por WhatsApp cuando un lead entra en «e1 EN ESPERA» (Captación). Ver
// docs/CAPTACION_WHATSAPP_ESPERA.md. Todo sale de variables de entorno; sin CAPTACION_WHATSAPP_ENABLED=true no
// arranca nada (ni webhooks, ni barrido, ni envíos), para que desplegar el código no escriba nunca a un lead.
import { toE164 } from '../netelip/phone.ts';
import { LISTA_CONTACTO_REFORMA } from '../reuniones-meet/clickup.ts';

export type ConfigCaptacion = {
  clickup: {
    token: string;
    lista: string;
    campoEtapa: string;          // ETAPA_CRM
    etapaEspera: string;         // «e1. EN ESPERA» (se compara sin puntos, espacios ni mayúsculas)
    campoTelefono: string;       // contact_phone_number
    campoPresupuesto: string;    // «Presupuesto formulario»: decide el remitente
    webhookSecret: string | null;
  };
  cloud: {
    token: string;
    versionApi: string;
    plantilla: string;
    idioma: string;
    appSecret: string | null;    // firma de los webhooks de estado (X-Hub-Signature-256)
    verifyToken: string | null;  // verificación GET del webhook en Meta
    /**
     * Variables del cuerpo de la plantilla, en orden ({{1}}, {{2}}…): «nombre» del comercial o «telefono» desde el que
     * llamará. Vacío = plantilla sin variables. Jean (17/11/2026): «…{{1}}, asesor de Grupo LyN, te llamará en breve
     * desde el número {{2}}…» → ['nombre', 'telefono'].
     */
    parametros: ParametroPlantilla[];
  } | null;
  /**
   * Desde qué número sale el aviso: el del comercial que llamará (Alex, 13/11/2026). Presupuesto del formulario con
   * límite inferior >= umbral (100.000 €) → «alto» (Ernesto); por debajo, sin presupuesto o sin rango reconocible →
   * «base» (Victor). numeroId es el phone_number_id de su número en la Cloud API; null = aún sin número.
   */
  remitentes: { umbral: number; alto: Remitente; base: Remitente };
  /** Franja de envío en hora de Madrid, en minutos desde medianoche; null = siempre. */
  horario: { desde: number; hasta: number } | null;
  /** Un aviso más antiguo que esto ya no se envía («te llamará en breve» no sirve horas después). */
  caducidadMinutos: number;
  /**
   * Modo QA: solo se escribe a estos teléfonos (E.164); el resto queda no_enviado con motivo «qa:». Así se prueba
   * contra la lista real de ClickUp sin escribir nunca a un lead real. null = producción (sin restricción).
   */
  soloTelefonos: string[] | null;
};

/** «+34 600 00 00 01, 600000002» → ['+34600000001', '+34600000002']. Vacío = null. */
export function parseSoloTelefonos(raw: string | undefined): string[] | null {
  const lista = String(raw || '').split(',').map((t) => t.trim()).filter(Boolean);
  if (!lista.length) return null;
  return lista.map((t) => {
    try {
      return toE164(t);
    } catch {
      throw new Error(`CAPTACION_WHATSAPP_SOLO_TELEFONOS: teléfono no válido «${t}»`);
    }
  });
}

/**
 * numeroId: phone_number_id del que sale el WhatsApp (por defecto el número general). telefonoLlamada: fijo de Netelip
 * desde el que llamará, tal como se muestra al lead en la plantilla («+34 865 45 61 34»); null = sin configurar.
 */
export type Remitente = { clave: 'alto' | 'base'; nombre: string; numeroId: string | null; telefonoLlamada: string | null };

export const PARAMETROS_PLANTILLA = ['nombre', 'telefono'] as const;
export type ParametroPlantilla = typeof PARAMETROS_PLANTILLA[number];

/** «nombre, telefono» → ['nombre', 'telefono']. Vacío = []. */
export function parseParametrosPlantilla(raw: string | undefined): ParametroPlantilla[] {
  return String(raw || '').split(',').map((p) => p.trim().toLowerCase()).filter(Boolean).map((p) => {
    if (!(PARAMETROS_PLANTILLA as readonly string[]).includes(p)) {
      throw new Error(`CAPTACION_WHATSAPP_PLANTILLA_PARAMETROS: «${p}» no válido (usa ${PARAMETROS_PLANTILLA.join(', ')})`);
    }
    return p as ParametroPlantilla;
  });
}

/** Valores de las variables de la plantilla para este remitente; null si falta alguno (el aviso espera). */
export function valoresPlantilla(parametros: ParametroPlantilla[], remitente: Remitente): string[] | null {
  const valores = parametros.map((p) => (p === 'nombre' ? remitente.nombre : remitente.telefonoLlamada));
  return valores.every((v): v is string => Boolean(v && v.trim())) ? valores : null;
}

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
  const numeroComun = env.WHATSAPP_CLOUD_PHONE_NUMBER_ID?.trim() || null;
  const plantilla = env.CAPTACION_WHATSAPP_PLANTILLA?.trim();
  const caducidad = Number(env.CAPTACION_WHATSAPP_CADUCIDAD_MINUTOS || 720);
  if (!Number.isInteger(caducidad) || caducidad < 1) throw new Error('CAPTACION_WHATSAPP_CADUCIDAD_MINUTOS debe ser un entero >= 1');
  const umbral = Number(env.CAPTACION_WHATSAPP_UMBRAL_PRESUPUESTO || 100_000);
  if (!Number.isFinite(umbral) || umbral < 0) throw new Error('CAPTACION_WHATSAPP_UMBRAL_PRESUPUESTO debe ser un número >= 0');
  // Sin número propio, el remitente usa el común (WHATSAPP_CLOUD_PHONE_NUMBER_ID), si lo hay.
  const remitente = (clave: 'alto' | 'base', nombrePorDefecto: string): Remitente => ({
    clave,
    nombre: env[`CAPTACION_WHATSAPP_REMITENTE_${clave.toUpperCase()}_NOMBRE`]?.trim() || nombrePorDefecto,
    numeroId: env[`CAPTACION_WHATSAPP_REMITENTE_${clave.toUpperCase()}_NUMERO_ID`]?.trim() || numeroComun,
    telefonoLlamada: env[`CAPTACION_WHATSAPP_REMITENTE_${clave.toUpperCase()}_TELEFONO`]?.trim() || null,
  });
  return {
    clickup: {
      token,
      lista: env.CAPTACION_CLICKUP_LISTA?.trim() || LISTA_CONTACTO_REFORMA,
      campoEtapa: env.CAPTACION_CLICKUP_CAMPO_ETAPA?.trim() || 'ETAPA_CRM',
      etapaEspera: env.CAPTACION_CLICKUP_ETAPA_ESPERA?.trim() || 'e1. EN ESPERA',
      campoTelefono: env.CAPTACION_CLICKUP_CAMPO_TELEFONO?.trim() || 'contact_phone_number',
      campoPresupuesto: env.CAPTACION_CLICKUP_CAMPO_PRESUPUESTO?.trim() || 'Presupuesto formulario',
      webhookSecret: env.CAPTACION_CLICKUP_WEBHOOK_SECRET?.trim() || null,
    },
    cloud: cloudToken && plantilla ? {
      token: cloudToken,
      versionApi: env.WHATSAPP_CLOUD_API_VERSION?.trim() || 'v23.0',
      plantilla,
      idioma: env.CAPTACION_WHATSAPP_IDIOMA?.trim() || 'es_ES',
      appSecret: env.WHATSAPP_CLOUD_APP_SECRET?.trim() || null,
      verifyToken: env.WHATSAPP_CLOUD_VERIFY_TOKEN?.trim() || null,
      parametros: parseParametrosPlantilla(env.CAPTACION_WHATSAPP_PLANTILLA_PARAMETROS),
    } : null,
    remitentes: { umbral, alto: remitente('alto', 'Ernesto'), base: remitente('base', 'Victor') },
    horario: parseHorario(env.CAPTACION_WHATSAPP_HORARIO),
    caducidadMinutos: caducidad,
    soloTelefonos: parseSoloTelefonos(env.CAPTACION_WHATSAPP_SOLO_TELEFONOS),
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

/**
 * Límite inferior de un rango del formulario: «Menos de 40.000 €» → 0, «40.000 € - 100.000 €» → 40000,
 * «Más de 200.000 €» → 200000. null si no hay rango o no lleva cifra («Pendiente…»).
 */
export function limiteInferiorPresupuesto(rango: string | null | undefined): number | null {
  const texto = String(rango || '').trim();
  if (!texto) return null;
  if (/^menos\s/i.test(texto)) return 0;
  const cifra = /\d{1,3}(?:[.\s]\d{3})+|\d{4,}/.exec(texto)?.[0];   // cifras de euros, no «1ª llamada»
  return cifra ? Number(cifra.replace(/[.\s]/g, '')) : null;
}

/** Remitente del aviso según el presupuesto del lead. Sin presupuesto reconocible, el de por defecto (base). */
export function elegirRemitente(rango: string | null | undefined, remitentes: ConfigCaptacion['remitentes']): Remitente {
  const limite = limiteInferiorPresupuesto(rango);
  return limite !== null && limite >= remitentes.umbral ? remitentes.alto : remitentes.base;
}
