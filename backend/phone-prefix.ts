import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { Pool } from 'pg';

type EvidenceDatabase = Pick<Pool, 'connect'>;

export const phonePrefixCandidatesQuery = `
  SELECT DISTINCT public.lyn_phone_evidence_sender_v1(message.remitente_jid,message.raw) AS sender
  FROM mensajes message
  JOIN chats chat ON chat.id=message.chat_id AND chat.account_id=message.account_id
  JOIN whatsapp_accounts account ON account.id=message.account_id AND account.activo=TRUE
  WHERE message.account_id=ANY($1::varchar[]) AND chat.account_id=ANY($1::varchar[])
    AND message.enviado_por_mi=FALSE AND message.source='evolution'
    AND chat.id LIKE '%@g.us' AND chat.nombre ~ '^Proyecto[[:space:]]+[^[:space:]]'
    AND message.timestamp>to_timestamp(0) AND message.timestamp<=NOW()
    AND ((LOWER(COALESCE(message.tipo,'text'))='text' AND BTRIM(COALESCE(message.texto,''))<>'')
      OR LOWER(message.tipo) IN ('image','video','audio','document','sticker','contact'))
    AND public.lyn_phone_evidence_sender_v1(message.remitente_jid,message.raw) IS NOT NULL`;

export function inferPhoneFromSenders(value: string, senders: readonly string[]): string | null {
  if (!/^[0-9().\s-]{8,80}$/.test(value)) return null;
  const digits = value.replace(/[\s().-]/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  const matches = new Set<string>();
  for (const sender of senders) {
    if (!/^[1-9][0-9]{7,14}$/.test(sender)) continue;
    const candidate = parsePhoneNumberFromString(`+${sender}`, { extract: false });
    if (!candidate?.isValid() || !candidate.country) continue;
    const national = parsePhoneNumberFromString(digits, { defaultCountry: candidate.country, extract: false });
    if (national?.isValid() && national.number === candidate.number) matches.add(candidate.number);
    if (matches.size > 1) return null;
  }
  return matches.size === 1 ? [...matches][0] : null;
}

export function createPhonePrefixInference(pool: EvidenceDatabase, now = Date.now) {
  let cached: { scope: string; expires: number; senders: string[] } | null = null;
  let pending: Promise<string[]> | null = null;
  return async (value: string, accountIds: string[]): Promise<string | null> => {
    if (!accountIds.length) throw new Error('Invalid evidence scope');
    const scope = accountIds.join(',');
    if (!cached || cached.scope !== scope || cached.expires <= now()) {
      if (!pending) pending = (async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN READ ONLY');
          await client.query("SET LOCAL statement_timeout='10s'");
          const { rows } = await client.query<{ sender: string }>(phonePrefixCandidatesQuery, [accountIds]);
          await client.query('COMMIT');
          return rows.map(row => row.sender);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally { client.release(); }
      })().finally(() => { pending = null; });
      const senders = await pending;
      cached = { scope, expires: now() + 60000, senders };
    }
    return inferPhoneFromSenders(value, cached.senders);
  };
}
