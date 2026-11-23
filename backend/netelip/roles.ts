// Roles con acceso a Netelip › Historial de llamadas. Debe coincidir con frontend/src/ceo-dashboard/CeoLogin.jsx.

import { ROL_CONSULTOR } from '../rol-consultor.ts';

// Quién ve Historial de llamadas (pedido de Alejandro Yepez, 14/10/2026). employee:superadmin y employee:admin:
// superadmin y admin que entran con el directorio de Supabase (CAL-09).
// consultor_lectura: personas de fuera, en solo lectura (backend/rol-consultor.ts).
export const DEFAULT_ACCESS_ROLES = `superadmin,admin,employee:superadmin,employee:admin,employee:director,employee:director_general,${ROL_CONSULTOR}`;
// P6: quién lee el texto. Mientras Producto no decida, los mismos roles que ven la sección.
const DEFAULT_READER_ROLES = DEFAULT_ACCESS_ROLES;
// Roles que solo consultan: la API les rechaza cualquier escritura (POST, PUT, PATCH, DELETE) en Netelip.
const DEFAULT_READONLY_ROLES = ROL_CONSULTOR;

export const normalizeRole = (role: unknown) =>
  String(role || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[\s/-]+/g, '_');

export const roleIn = (role: unknown, list: string) => list.split(',').map(normalizeRole).filter(Boolean).includes(normalizeRole(role));

/** Roles que ven la sección y usan la API de lectura. */
export function canAccessNetelipCalls(role: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return roleIn(role, String(env.NETELIP_ACCESS_ROLES || DEFAULT_ACCESS_ROLES));
}

/** P6: roles que leen el texto de las transcripciones (siempre dentro de los que ven la sección). */
export function canReadTranscripts(role: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return canAccessNetelipCalls(role, env) && roleIn(role, String(env.NETELIP_TRANSCRIPT_READER_ROLES || DEFAULT_READER_ROLES));
}

/** Roles de solo lectura: ven lo mismo que su acceso permita, pero no cambian nada. */
export function isNetelipReadOnly(role: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return roleIn(role, String(env.NETELIP_READONLY_ROLES || DEFAULT_READONLY_ROLES));
}
