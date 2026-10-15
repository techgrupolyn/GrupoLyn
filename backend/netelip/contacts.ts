// Vinculación de llamadas con leads y clientes por teléfono E.164.
//
// Los teléfonos del directorio son texto libre (clientes.telefono, crm_leads.phone): se normalizan
// aquí, en memoria. Un lead convertido en cliente (crm_leads.client_id) cuenta como ese cliente.
import type { Pool, PoolClient } from 'pg';
import { tryE164 } from './phone.ts';

type Queryable = Pool | PoolClient;
export type ContactRef = { type: 'client' | 'lead'; id: string };
export type ContactMatch =
  | { status: 'matched'; client_id: string | null; lead_id: string | null }
  | { status: 'unknown' | 'hidden' | 'multiple'; client_id: null; lead_id: null };

export type DirectoryIndex = Map<string, { clients: Set<string>; leads: Map<string, string | null> }>;

export async function loadDirectoryIndex(db: Queryable): Promise<DirectoryIndex> {
  const [clients, leads] = await Promise.all([
    db.query<{ id: string; telefono: string }>("SELECT id, telefono FROM clientes WHERE activo = TRUE AND COALESCE(telefono,'') <> ''"),
    db.query<{ id: string; phone: string; client_id: string | null }>("SELECT id::text AS id, phone, client_id FROM crm_leads WHERE COALESCE(phone,'') <> ''"),
  ]);
  const index: DirectoryIndex = new Map();
  const entry = (phone: string) => {
    let value = index.get(phone);
    if (!value) index.set(phone, value = { clients: new Set(), leads: new Map() });
    return value;
  };
  for (const row of clients.rows) {
    const phone = tryE164(row.telefono);
    if (phone) entry(phone).clients.add(row.id);
  }
  for (const row of leads.rows) {
    const phone = tryE164(row.phone);
    if (phone) entry(phone).leads.set(row.id, row.client_id);
  }
  return index;
}

export function matchPhone(index: DirectoryIndex, phoneE164: string | null): ContactMatch {
  if (!phoneE164) return { status: 'hidden', client_id: null, lead_id: null };
  const found = index.get(phoneE164);
  if (!found) return { status: 'unknown', client_id: null, lead_id: null };
  const candidates: ContactRef[] = [...found.clients].map((id) => ({ type: 'client', id }));
  for (const [leadId, clientId] of found.leads) {
    if (clientId && found.clients.has(clientId)) continue; // lead ya convertido en ese cliente
    candidates.push({ type: 'lead', id: leadId });
  }
  if (candidates.length === 0) return { status: 'unknown', client_id: null, lead_id: null };
  if (candidates.length > 1) return { status: 'multiple', client_id: null, lead_id: null };
  const [only] = candidates;
  return { status: 'matched', client_id: only.type === 'client' ? only.id : null, lead_id: only.type === 'lead' ? only.id : null };
}

/**
 * Re-vincula las llamadas con teléfono cuando el directorio cambia: un teléfono pendiente que ya
 * tiene lead o cliente, una coincidencia múltiple que se resolvió o un vínculo que dejó de valer.
 * Las llamadas con número oculto no se tocan. Devuelve cuántas llamadas cambiaron.
 */
export async function relinkCalls(pool: Pool, phones?: string[]): Promise<number> {
  const index = await loadDirectoryIndex(pool);
  const filter = phones?.length ? 'AND phone_e164 = ANY($1::text[])' : '';
  const { rows } = await pool.query<{ phone_e164: string; contact_status: string; client_id: string | null; lead_id: string | null }>(
    `SELECT DISTINCT phone_e164, contact_status, client_id, lead_id::text AS lead_id
     FROM netelip_calls WHERE phone_e164 IS NOT NULL ${filter}`,
    phones?.length ? [phones] : [],
  );
  let changed = 0;
  for (const row of rows) {
    const match = matchPhone(index, row.phone_e164);
    if (match.status === row.contact_status && match.client_id === row.client_id && match.lead_id === row.lead_id) continue;
    const result = await pool.query(
      `UPDATE netelip_calls SET contact_status=$2, client_id=$3, lead_id=$4::uuid, linked_at=NOW()
       WHERE phone_e164=$1 AND contact_status=$5 AND client_id IS NOT DISTINCT FROM $6 AND lead_id IS NOT DISTINCT FROM $7::uuid`,
      [row.phone_e164, match.status, match.client_id, match.lead_id, row.contact_status, row.client_id, row.lead_id],
    );
    changed += result.rowCount || 0;
  }
  return changed;
}
