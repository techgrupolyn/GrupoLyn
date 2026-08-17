// Interfaces TypeScript para el proyecto

export interface EvolutionInstance {
  instance?: {
    instanceName?: string;
    state?: string;
    status?: string;
  };
  instanceName?: string;
  name?: string;
  state?: string;
  status?: string;
}

export interface MessageKey {
  id?: string;
  remoteJid?: string;
  remoteJidAlt?: string;
}

export interface TextMessage {
  text?: string;
}

export interface ImageMessage {
  caption?: string;
  url?: string;
  mimetype?: string;
}

export interface VideoMessage {
  caption?: string;
  url?: string;
  mimetype?: string;
}

export interface DocumentMessage {
  caption?: string;
  url?: string;
  mimetype?: string;
}

export interface AudioMessage {
  url?: string;
  mimetype?: string;
}

export interface PttMessage {
  url?: string;
  mimetype?: string;
}

export interface StickerMessage {
  url?: string;
  mimetype?: string;
}

export interface ButtonsResponseMessage {
  selectedDisplayText?: string;
}

export interface ListResponseMessage {
  title?: string;
}

export interface MessageItem {
  key?: MessageKey;
  id?: string;
  remoteJid?: string;
  remoteJidAlt?: string;
  pushName?: string;
  name?: string;
  subject?: string;
  unreadCount?: number;
  conversation?: string;
  extendedTextMessage?: TextMessage;
  imageMessage?: ImageMessage;
  videoMessage?: VideoMessage;
  documentMessage?: DocumentMessage;
  audioMessage?: AudioMessage;
  ptvMessage?: PttMessage;
  stickerMessage?: StickerMessage;
  buttonsResponseMessage?: ButtonsResponseMessage;
  listResponseMessage?: ListResponseMessage;
  message?: any;
  messageTimestamp?: number;
  timestamp?: number;
}

export interface ChatItem {
  remoteJid?: string;
  id?: string;
  pushName?: string;
  name?: string;
  lastMessage?: MessageItem;
  updatedAt?: number | string;
}

export interface WebhookPayload {
  event?: string;
  data?: any;
  messages?: MessageItem[];
}

export interface ConnectionStatus {
  connected: boolean;
  state: string;
  error?: string;
}

export interface QRResponse {
  connected: boolean;
  qr: string | null;
  state?: string;
  error?: string;
}

export interface Chat {
  id: string;
  nombre: string;
  updated_at: Date;
  ultimo_mensaje?: string;
  profile_picture_url?: string;
  classification?: { rol: string; urgencia: string };
}

export interface Mensaje {
  id: string;
  chat_id: string;
  remitente: string;
  remitente_jid?: string;
  texto: string;
  timestamp: Date;
  enviado_por_mi?: boolean;
  tipo?: string;
  media?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  estado?: string;
}

export interface AnalisisIA {
  mensaje_id: string;
  grupo_id: string;
  rol_requerido: string;
  necesita_accion: boolean;
  urgencia: string;
  confianza: number;
  prompt_utilizado?: string;
  created_at: Date;
}

export interface ResumenRequest {
  grupo: string;
  dias: number;
}

export interface ResumenResponse {
  grupo: string;
  dias: number;
  resumen: string;
  puntos_clave: string[];
  acciones_requeridas: string[];
}

export interface RoleClassification {
  rol: string;
  confianza: number;
  necesita_accion: boolean;
  urgencia: 'baja' | 'media' | 'alta';
}

export interface Specialist {
  id: string;
  nombre: string;
  rol: string;
  system_prompt: string;
}
