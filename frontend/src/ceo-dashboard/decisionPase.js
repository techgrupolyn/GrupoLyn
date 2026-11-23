// Decisión de pase del SDR (N-1.4): textos y ayudas compartidas por el formulario del SDR (detalle de la llamada) y la bandeja de Ernesto.

export const DECISIONES = ['pasar_a_reunion', 'derivar_partners', 'seguimiento', 'descartar'];
export const DECISION_LABEL = {
  pasar_a_reunion: 'Pasar a reunión', derivar_partners: 'Derivar a LYN Partners', seguimiento: 'Seguimiento', descartar: 'Descartar',
};
export const ESCALADO_LABEL = { discrepancia: 'Discrepancia', excepcion: 'Excepción', duda: 'Duda', piloto: 'Piloto' };
export const ESTADO_LABEL = { pendiente_ernesto: 'Pendiente de Ernesto', validada: 'Validada', corregida: 'Corregida' };
export const EXCEPCION_LABEL = {
  descuento: 'Descuento', condiciones_pago: 'Condiciones de pago', topografo: 'Topógrafo (alguien tiene que ir a medir)', fuera_de_zona: 'Fuera de zona',
  videollamada: 'Sesión por videollamada', sin_decisor: 'Sesión sin uno de los decisores',
};
export const DUDA_LABEL = { presupuesto_limite: 'Presupuesto al límite', encaje_incierto: 'Encaje incierto entre LYN y Partners', viabilidad_tecnica: 'Viabilidad técnica pendiente' };
export const CANAL_LABEL = { llamada: 'Llamada', whatsapp: 'WhatsApp', email: 'Email' };
export const OTRO = 'otro';

/** Etiqueta legible de un motivo: la de la lista configurada, o el texto libre si es «otro». */
export function motivoLabel(motivos, decision, codigo, texto) {
  if (!codigo) return '—';
  if (codigo === OTRO) return texto ? `Otro: ${texto}` : 'Otro';
  return motivos?.[decision]?.find((m) => m.codigo === codigo)?.etiqueta || codigo;
}

/** Id numérico de la llamada de Netelip a partir del id de interacción del caso («netelip:123» → «123»). */
export const callIdDe = (llamadaId) => String(llamadaId || '').split(':').pop();

/** Antigüedad de un caso en texto corto («3 h», «2 d»); vacío si la fecha no es válida. */
export function antiguedad(desde, ahora = Date.now()) {
  const t = new Date(desde).getTime();
  if (!Number.isFinite(t)) return '';
  const min = Math.max(0, Math.floor((ahora - t) / 60000));
  if (min < 60) return `${min} min`;
  if (min < 60 * 24) return `${Math.floor(min / 60)} h`;
  return `${Math.floor(min / 1440)} d`;
}

/** Enlace a la tarjeta del lead en ClickUp (el id de la tarea no identifica a nadie por sí solo). */
export const tarjetaUrl = (leadId) => `https://app.clickup.com/t/${encodeURIComponent(leadId)}`;
