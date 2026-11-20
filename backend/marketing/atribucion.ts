// Reglas de atribución que decide el código: canal, zona, familia de creativo y letra.
import { LETRAS, type Letra } from './schema.ts';

export type Regla = { patron: string; valor: string; prioridad: number };
/** Zona especial: las campañas que no son de captación (p. ej. ofertas de empleo) no entran en el panel. */
export const ZONA_EXCLUIDA = 'Excluida';
export type Canal = 'meta' | 'google' | 'tally' | 'otro';

const plano = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Canal del lead. Manda utm_source si existe (atribución 869fnzbwu); si no, el campo canal de ClickUp
 * según Daniel Duarte (04/11): 1 Tally · 2 Google · 3, 3.1 y 3.2 Meta (P-06) · el resto, canales manuales.
 */
export function canalDelLead(utmSource: unknown, canalOrigen: unknown): Canal {
  const utm = plano(utmSource).trim();
  if (['meta', 'facebook', 'fb', 'instagram', 'ig'].includes(utm)) return 'meta';
  if (['google', 'adwords', 'gads'].includes(utm)) return 'google';
  const c = String(canalOrigen ?? '').trim().replace(',', '.');
  if (c === '1') return 'tally';
  if (c === '2') return 'google';
  if (/^3(\.\d+)?$/.test(c)) return 'meta';
  return 'otro';
}

/** Zona de una campaña: la regla cuyo patrón aparece antes en el nombre; a igual posición, menor prioridad. */
export function zonaDeCampana(campana: unknown, reglas: Regla[]): string {
  const nombre = plano(campana);
  let mejor: { pos: number; prioridad: number; valor: string } | null = null;
  for (const r of reglas) {
    const pos = nombre.indexOf(plano(r.patron));
    if (pos < 0 || !r.patron) continue;
    if (!mejor || pos < mejor.pos || (pos === mejor.pos && r.prioridad < mejor.prioridad)) mejor = { pos, prioridad: r.prioridad, valor: r.valor };
  }
  return mejor?.valor ?? 'Sin zona';
}

/** Familia de un anuncio: la primera regla (por prioridad) cuyo patrón contiene el nombre. */
export function familiaDeAnuncio(anuncio: unknown, reglas: Regla[]): string {
  const nombre = plano(anuncio);
  const r = [...reglas].sort((a, b) => a.prioridad - b.prioridad).find((x) => x.patron && nombre.includes(plano(x.patron)));
  return r?.valor ?? 'Sin familia';
}

/** Letra del calificador a partir del texto del campo (p. ej. «A+», «b», «No apto», «Presupuesto insuficiente»). */
export function normalizarLetra(valor: unknown): Letra | null {
  const t = plano(valor).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.includes('no apto') || t.includes('insuficiente')) return 'No apto';
  const m = t.match(/^(a\+\+|a\+|a|b|c|d)(?![a-z0-9+])/);
  if (!m) return null;
  const letra = m[1].toUpperCase();
  return (LETRAS as readonly string[]).includes(letra) ? letra as Letra : null;
}
