// Direct chats use the durable inbox, without group employee fanout or automatic AI.
export function isReceivableWhatsAppJid(jid: unknown): boolean {
  return typeof jid === 'string' && (/^\d+(?:-\d+)?@g\.us$/.test(jid)
    || /^\d{7,15}@(?:s\.whatsapp\.net|c\.us|lid)$/.test(jid));
}

export function directPhone(jid: unknown, alternate: unknown): string | null {
  if (!isReceivableWhatsAppJid(jid) || String(jid).endsWith('@g.us')) return null;
  const phones = new Set([jid, alternate].flatMap(value => {
    const m = typeof value === 'string' ? value.match(/^(\d{9,15})@(?:s\.whatsapp\.net|c\.us)$/) : null;
    return m ? [m[1]] : [];
  }));
  return phones.size === 1 ? [...phones][0] : null;
}

export const associateDirectClientSql = `WITH candidate AS (
  SELECT min(c.id) AS id FROM clientes c
  WHERE c.activo AND regexp_replace(coalesce(c.telefono,''),'[^0-9]','','g')=$3
  HAVING count(*)=1 AND NOT EXISTS (
    SELECT 1 FROM empleados e WHERE e.activo
    AND regexp_replace(coalesce(e.numero,''),'[^0-9]','','g')=$3)
)
UPDATE mensajes m SET cliente_id=c.id, autor_tipo='cliente'
FROM candidate c WHERE c.id IS NOT NULL AND m.id=$1 AND m.account_id=$2
AND m.canal='whatsapp' AND NOT m.enviado_por_mi AND m.empleado_id IS NULL
AND (m.cliente_id IS NULL OR m.cliente_id=c.id)
RETURNING m.cliente_id`;

export async function associateDirectClient(
  query: (sql: string, params: string[]) => Promise<unknown>,
  messageId: string, accountId: string, jid: unknown, alternate: unknown, fromMe: boolean,
): Promise<void> {
  if (fromMe) return;
  const phone = directPhone(jid, alternate);
  if (phone) await query(associateDirectClientSql, [messageId, accountId, phone]);
}
