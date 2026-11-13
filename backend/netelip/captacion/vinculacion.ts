// N-1.2 · Vincular una llamada con su lead (ticket 869fny1eg). Lógica pura: quien la usa pasa la lista
// de tareas candidatas (ya filtradas por la lista de ClickUp) y recibe a qué tarea pertenece la llamada.

export interface LeadCandidato {
  clickupTaskId: string;
  /** Solo se vinculan tareas padre; las subtareas se ignoran. */
  esTareaPadre: boolean;
  telefono: string | null;
  email: string | null;
}

export interface ContactoLlamada {
  /** Teléfono de la contraparte, mejor ya en formato E.164 (+34…). Una llamada con número oculto no lo trae. */
  telefono?: string | null;
  email?: string | null;
}

export type ResultadoVinculacion =
  | { estado: 'vinculado'; clickupTaskId: string; via: 'telefono' | 'email' }
  | { estado: 'sin_lead'; motivo: 'sin_datos' | 'sin_coincidencia' | 'varias_coincidencias' };

/**
 * Solo los dígitos, sin el «00» internacional de cabecera, y un número español sin su prefijo (34 + 9 dígitos
 * = 11): «+34 600-111-222», «0034600111222» y «600111222» son el mismo teléfono. En ClickUp el 97 % de los
 * teléfonos ya viene como +34XXXXXXXXX, pero uno escrito a mano sin prefijo no debe quedarse sin coincidir.
 */
export function claveTelefono(valor: string | null | undefined): string | null {
  const digitos = String(valor ?? '').replace(/\D/g, '').replace(/^00/, '');
  const nacional = digitos.length === 11 && digitos.startsWith('34') ? digitos.slice(2) : digitos;
  return nacional.length >= 6 ? nacional : null;
}

export function claveEmail(valor: string | null | undefined): string | null {
  const limpio = String(valor ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(limpio) ? limpio : null;
}

const unicas = (ids: string[]): string[] => [...new Set(ids)];

/**
 * Primero por teléfono; si ninguna tarea coincide, por email. Sin una coincidencia única (ninguna o
 * varias) la llamada queda como «sin lead» y no escribe nada.
 */
export function vincularLlamadaConLead(contacto: ContactoLlamada, leads: readonly LeadCandidato[]): ResultadoVinculacion {
  const telefono = claveTelefono(contacto.telefono);
  const email = claveEmail(contacto.email);
  if (telefono === null && email === null) return { estado: 'sin_lead', motivo: 'sin_datos' };

  const padres = leads.filter((l) => l.esTareaPadre);
  if (telefono !== null) {
    const porTelefono = unicas(padres.filter((l) => claveTelefono(l.telefono) === telefono).map((l) => l.clickupTaskId));
    if (porTelefono.length === 1) return { estado: 'vinculado', clickupTaskId: porTelefono[0] as string, via: 'telefono' };
    if (porTelefono.length > 1) return { estado: 'sin_lead', motivo: 'varias_coincidencias' };
  }
  if (email !== null) {
    const porEmail = unicas(padres.filter((l) => claveEmail(l.email) === email).map((l) => l.clickupTaskId));
    if (porEmail.length === 1) return { estado: 'vinculado', clickupTaskId: porEmail[0] as string, via: 'email' };
    if (porEmail.length > 1) return { estado: 'sin_lead', motivo: 'varias_coincidencias' };
  }
  return { estado: 'sin_lead', motivo: 'sin_coincidencia' };
}
