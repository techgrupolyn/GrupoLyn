import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { rollbackMeetingProjectLinks } from '../meeting-project-link-rollback.ts';

describe.skipIf(!process.env.QA_TEST_DATABASE_URL)('Reversión auditada de vínculos automáticos', () => {
  async function fixture() {
    const url = new URL(process.env.QA_TEST_DATABASE_URL!);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/lyn_qa_retest') throw new Error('Solo QA local');
    const pool = new Pool({ connectionString: url.toString(), max: 1 });
    const client = await pool.connect();
    await client.query(`
      CREATE TEMP TABLE meeting_reviews(artifact_id UUID PRIMARY KEY,status TEXT,analysis_status TEXT,manual_revision BOOLEAN);
      CREATE TEMP TABLE meeting_review_actions(id UUID PRIMARY KEY,artifact_id UUID,project_id TEXT,project_name TEXT,project_unresolved BOOLEAN,origin TEXT,status TEXT,updated_at TIMESTAMPTZ,responsible_id TEXT);
      CREATE TEMP TABLE meeting_project_drafts(artifact_id UUID);
      CREATE TEMP TABLE meeting_review_versions(id UUID PRIMARY KEY,artifact_id UUID,actor TEXT,stage TEXT,detail TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
    `);
    const links = [];
    for (let index = 0; index < 2; index++) {
      const artifactId = randomUUID(), actionId = randomUUID(), auditId = randomUUID();
      await client.query("INSERT INTO meeting_reviews VALUES($1,'pending','completed',FALSE)", [artifactId]);
      await client.query("INSERT INTO meeting_review_actions VALUES($1,$2,'project','Proyecto',FALSE,'ai','pending','2026-01-01T10:00:00.123456Z','person')", [actionId, artifactId]);
      await client.query("INSERT INTO meeting_review_versions VALUES($1,$2,'directory-sync','project-linked',$3,'2026-01-01T10:00:00.123456Z')", [auditId, artifactId, JSON.stringify({ actionId,
        before: { project_id: null, project_name: 'Nombre original', project_unresolved: false },
        after: { project_id: 'project', project_name: 'Proyecto', project_unresolved: false } })]);
      links.push({ artifactId, actionId, auditId });
    }
    return { client, links, async close() { await client.query('ROLLBACK'); client.release(); await pool.end(); } };
  }

  it('previsualiza sin escribir y restaura solo vínculos sin borrar responsables ni la auditoría', async () => {
    const { client, links, close } = await fixture();
    try {
      const auditIds = links.map(link => link.auditId);
      await client.query('BEGIN READ ONLY');
      expect(await rollbackMeetingProjectLinks(client, auditIds, 'Corrección confirmada')).toHaveLength(2);
      expect((await client.query("SELECT * FROM meeting_review_actions WHERE project_id='project'")).rowCount).toBe(2);
      expect((await client.query('SELECT * FROM meeting_review_versions')).rowCount).toBe(2);
      await client.query('COMMIT');
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await rollbackMeetingProjectLinks(client, auditIds, 'Corrección confirmada', false);
      await client.query('COMMIT');
      const actions = (await client.query('SELECT project_id,project_name,responsible_id FROM meeting_review_actions')).rows;
      expect(actions).toEqual(Array.from({ length: 2 }, () => ({ project_id: null, project_name: 'Nombre original', responsible_id: 'person' })));
      expect((await client.query("SELECT * FROM meeting_review_versions WHERE stage='project-link-reverted'")).rowCount).toBe(2);
      expect((await client.query("SELECT * FROM meeting_review_versions WHERE stage='project-linked'")).rowCount).toBe(2);
      await expect(rollbackMeetingProjectLinks(client, auditIds, 'Repetición')).rejects.toThrow('Reversión cancelada');
    } finally { await close(); }
  });

  it.each(['changed', 'approved', 'draft', 'manual'])('rechaza el lote completo si una acción está protegida: %s', async kind => {
    const { client, links, close } = await fixture();
    try {
      if (kind === 'changed') await client.query("UPDATE meeting_review_actions SET updated_at=updated_at+interval '1 microsecond' WHERE id=$1", [links[1].actionId]);
      if (kind === 'approved') await client.query("UPDATE meeting_reviews SET status='approved' WHERE artifact_id=$1", [links[1].artifactId]);
      if (kind === 'manual') await client.query('UPDATE meeting_reviews SET manual_revision=TRUE WHERE artifact_id=$1', [links[1].artifactId]);
      if (kind === 'draft') await client.query('INSERT INTO meeting_project_drafts VALUES($1)', [links[1].artifactId]);
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await expect(rollbackMeetingProjectLinks(client, links.map(link => link.auditId), 'No sobrescribir', false)).rejects.toThrow('Reversión cancelada');
      await client.query('ROLLBACK');
      expect((await client.query("SELECT * FROM meeting_review_actions WHERE project_id='project'")).rowCount).toBe(2);
      expect((await client.query('SELECT * FROM meeting_review_versions')).rowCount).toBe(2);
    } finally { await close(); }
  });

  it('un fallo al registrar la reversión no deja acciones desvinculadas', async () => {
    const { client, links, close } = await fixture();
    try {
      await client.query("ALTER TABLE meeting_review_versions ADD CONSTRAINT reject_rollback CHECK(stage<>'project-link-reverted')");
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await expect(rollbackMeetingProjectLinks(client, links.map(link => link.auditId), 'Prueba de atomicidad', false)).rejects.toThrow();
      await client.query('ROLLBACK');
      expect((await client.query("SELECT * FROM meeting_review_actions WHERE project_id='project'")).rowCount).toBe(2);
    } finally { await close(); }
  });

  it('exige motivo e identificadores originales únicos, sin aceptar auditorías ajenas', async () => {
    const { client, links, close } = await fixture();
    try {
      await expect(rollbackMeetingProjectLinks(client, [links[0].auditId], '')).rejects.toThrow('motivo');
      await expect(rollbackMeetingProjectLinks(client, [links[0].auditId, links[0].auditId], 'Prueba')).rejects.toThrow('únicos');
      await expect(rollbackMeetingProjectLinks(client, [randomUUID()], 'Prueba')).rejects.toThrow('auditoría original');
      await client.query("UPDATE meeting_review_versions SET actor='someone-else' WHERE id=$1", [links[0].auditId]);
      await expect(rollbackMeetingProjectLinks(client, [links[0].auditId], 'Prueba')).rejects.toThrow('auditoría original');
    } finally { await close(); }
  });
});
