import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPhoneEvidenceLookup, phoneEvidenceQuery, phoneEvidenceReferenceQuery, phoneEvidenceSenderPrefilter } from '../phone-evidence.ts';

const databaseUrl = process.env.QA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('Evidencia WhatsApp en PostgreSQL QA local', () => {
  let pool: Pool;
  let lookup: ReturnType<typeof createPhoneEvidenceLookup>;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    const localPort = url.port === '15439' || (process.env.CI === 'true' && url.port === '5432');
    if (url.hostname !== '127.0.0.1' || !localPort || url.pathname !== '/lyn_qa_retest') throw new Error('Solo QA local');
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query(`CREATE TEMP TABLE whatsapp_accounts(id varchar PRIMARY KEY, activo boolean);
      CREATE TEMP TABLE chats(id varchar PRIMARY KEY, account_id varchar, nombre varchar);
      CREATE TEMP TABLE mensajes(id varchar PRIMARY KEY,chat_id varchar,account_id varchar,remitente_jid varchar,
        raw jsonb,enviado_por_mi boolean,source varchar,tipo varchar,texto text,timestamp timestamptz);`);
    await pool.query(await readFile(new URL('../migrations/20261020_phone_evidence_sender.sql', import.meta.url), 'utf8'));
    await pool.query((await readFile(new URL('../migrations/20261020_phone_evidence_index.sql', import.meta.url), 'utf8'))
      .replace(' CONCURRENTLY', '').replace('ON public.mensajes', 'ON mensajes'));
    lookup = createPhoneEvidenceLookup(pool);
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE mensajes,chats,whatsapp_accounts;
      INSERT INTO whatsapp_accounts VALUES ('allowed',TRUE),('foreign',TRUE),('inactive',FALSE);
      INSERT INTO chats VALUES ('allowed::1@g.us','allowed','Proyecto Dana'),
        ('foreign::1@g.us','foreign','Proyecto Privado'),('inactive::1@g.us','inactive','Proyecto Inactivo'),
        ('allowed::2@g.us','allowed','Familia'),('allowed::600@s.whatsapp.net','allowed','Proyecto Directo');
      INSERT INTO mensajes VALUES('message','allowed::1@g.us','allowed','34600123456@s.whatsapp.net',
        '{"key":{"fromMe":false}}',FALSE,'evolution','text','Contenido que nunca debe viajar','2025-01-01T10:00:00Z');`);
  });
  afterAll(async () => { if (pool) await pool.end(); });
  it('verifica un mensaje antiguo y devuelve solo proyecto y fecha', async () => {
    expect(await lookup('+34600123456', ['allowed'])).toEqual({ project: 'Dana', last_message_at: '2025-01-01T10:00:00.000Z' });
  });
  it('elige el último mensaje y su proyecto, no el primer grupo', async () => {
    await pool.query(`INSERT INTO chats VALUES('allowed::3@g.us','allowed','Proyecto Otro');
      INSERT INTO mensajes SELECT 'latest','allowed::3@g.us',account_id,remitente_jid,raw,enviado_por_mi,source,tipo,texto,'2025-02-01T10:00:00Z' FROM mensajes;`);
    expect(await lookup('+34600123456', ['allowed'])).toEqual({ project: 'Otro', last_message_at: '2025-02-01T10:00:00.000Z' });
  });
  it.each([
    "UPDATE mensajes SET account_id='foreign',chat_id='foreign::1@g.us'",
    "UPDATE mensajes SET account_id='inactive',chat_id='inactive::1@g.us'",
    "UPDATE mensajes SET chat_id='foreign::1@g.us'",
    "UPDATE mensajes SET chat_id='allowed::2@g.us'",
    "UPDATE mensajes SET chat_id='allowed::600@s.whatsapp.net'",
    "UPDATE mensajes SET enviado_por_mi=TRUE",
    "UPDATE mensajes SET raw='{\"key\":{\"fromMe\":true}}'",
    "UPDATE mensajes SET source='dashboard'",
    "UPDATE mensajes SET texto='   '",
    "UPDATE mensajes SET tipo='protocolMessage'",
    "UPDATE mensajes SET timestamp=NOW()+INTERVAL '1 day'",
    "UPDATE mensajes SET remitente_jid='34600123456@lid'",
    "UPDATE mensajes SET remitente_jid='1234600123456@s.whatsapp.net'",
    "UPDATE mensajes SET remitente_jid='34600123456@g.us'",
    "UPDATE mensajes SET remitente_jid=NULL,raw='{\"remoteJid\":\"34600123456@s.whatsapp.net\"}'",
    "UPDATE mensajes SET remitente_jid=NULL,raw='{\"message\":{\"extendedTextMessage\":{\"contextInfo\":{\"participant\":\"34600123456@s.whatsapp.net\"}}}}'",
    "UPDATE chats SET nombre='Proyecto ' WHERE account_id='allowed'",
  ])('no acepta evidencia fuera de alcance o no fiable: %s', async update => {
    await pool.query(update);
    expect(await lookup('+34600123456', ['allowed'])).toBeNull();
  });
  it('permite solo las cuentas incluidas por configuración', async () => {
    await pool.query("UPDATE mensajes SET account_id='foreign',chat_id='foreign::1@g.us'");
    expect(await lookup('+34600123456', ['allowed', 'foreign'])).toMatchObject({ project: 'Privado' });
  });
  it('admite un JID telefónico con dispositivo sin comparar por sufijo', async () => {
    await pool.query("UPDATE mensajes SET remitente_jid='34600123456:12@s.whatsapp.net'");
    expect(await lookup('+34600123456', ['allowed'])).not.toBeNull();
  });
  it('recupera el participante del sobre original, no del texto ni del nombre', async () => {
    await pool.query(`UPDATE mensajes SET remitente_jid=NULL,raw='{"key":{"participant":"34600123456@s.whatsapp.net"}}'`);
    expect(await lookup('+34600123456', ['allowed'])).not.toBeNull();
  });
  it('admite la correspondencia telefónica explícita de un LID y rechaza identidades contradictorias', async () => {
    await pool.query(`UPDATE mensajes SET remitente_jid='999999999999@lid',
      raw='{"key":{"participant":"999999999999@lid","participantAlt":"34600123456@s.whatsapp.net"}}'`);
    expect(await lookup('+34600123456', ['allowed'])).not.toBeNull();
    await pool.query("UPDATE mensajes SET remitente_jid='34699123456@s.whatsapp.net'");
    expect(await lookup('+34600123456', ['allowed'])).toBeNull();
  });
  it('un adjunto enviado cuenta como participación, sin extraer su contenido', async () => {
    await pool.query("UPDATE mensajes SET tipo='audio',texto=''");
    expect(await lookup('+34600123456', ['allowed'])).not.toBeNull();
  });
  it('no escribe ni cambia el remitente o contenido del mensaje', async () => {
    const before = (await pool.query('SELECT * FROM mensajes')).rows;
    await lookup('+34600123456', ['allowed']);
    expect((await pool.query('SELECT * FROM mensajes')).rows).toEqual(before);
  });
  it('el prefiltro conserva el resultado original para PN, dispositivos, LID y conflictos', async () => {
    const withoutPrefilter = phoneEvidenceReferenceQuery.replace(phoneEvidenceSenderPrefilter, '');
    for (const sender of [null, '34600123456@s.whatsapp.net', '34699123456@s.whatsapp.net',
      '34600123456:12@c.us', '999999999999@lid', 'invalid']) {
      for (const participant of ['34600123456@s.whatsapp.net', '34699123456@s.whatsapp.net', '999999999999@lid']) {
        await pool.query('UPDATE mensajes SET remitente_jid=$1,raw=$2', [sender, { key: { participant, fromMe: false } }]);
        const args = ['34600123456', ['allowed']];
        const optimized = (await pool.query(phoneEvidenceQuery, args)).rows;
        expect(optimized).toEqual((await pool.query(withoutPrefilter, args)).rows);
      }
    }
  });
});
