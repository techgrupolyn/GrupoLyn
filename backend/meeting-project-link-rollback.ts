import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

type ProjectLink = { project_id: string | null; project_name: string | null; project_unresolved: boolean };
type LinkAudit = { actionId: string; before: ProjectLink; after: ProjectLink };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function rollbackMeetingProjectLinks(client: PoolClient, auditIds: string[], reason: string, dryRun = true) {
  if (!reason.trim()) throw new Error('Indica un motivo para la reversión.');
  if (!auditIds.length || auditIds.some(id => !uuid.test(id)) || new Set(auditIds).size !== auditIds.length) throw new Error('Indica identificadores de auditoría únicos y válidos.');
  const audits = (await client.query<{ id: string; artifact_id: string; detail: string }>(`
    SELECT id,artifact_id,detail FROM meeting_review_versions
    WHERE id=ANY($1::uuid[]) AND actor='directory-sync' AND stage='project-linked'
    ORDER BY artifact_id,id`, [auditIds])).rows;
  if (audits.length !== auditIds.length) throw new Error('No se encontró la auditoría original de todos los vínculos.');
  const changes: { auditId: string; actionId: string; artifactId: string; before: ProjectLink; after: ProjectLink }[] = [];
  for (const audit of audits) {
    const detail = JSON.parse(audit.detail) as LinkAudit;
    if (!uuid.test(detail.actionId || '') || detail.before?.project_id !== null || !detail.after?.project_id
      || (detail.before.project_name !== null && typeof detail.before.project_name !== 'string')
      || typeof detail.before.project_unresolved !== 'boolean' || typeof detail.after.project_name !== 'string'
      || detail.after.project_unresolved !== false || changes.some(change => change.actionId === detail.actionId)) {
      throw new Error('La auditoría no contiene un vínculo automático reversible.');
    }
    const current = (await client.query(`
      SELECT action.id FROM meeting_review_actions action
      JOIN meeting_reviews review ON review.artifact_id=action.artifact_id
      JOIN meeting_review_versions version ON version.id=$1
      WHERE action.id=$2 AND action.artifact_id=$3 AND action.origin='ai' AND action.status='pending'
        AND action.project_id=$4 AND action.project_name IS NOT DISTINCT FROM $5
        AND action.project_unresolved=$6 AND action.updated_at=version.created_at
        AND review.status<>'approved' AND review.analysis_status='completed' AND review.manual_revision=FALSE
        AND NOT EXISTS(SELECT 1 FROM meeting_project_drafts draft WHERE draft.artifact_id=action.artifact_id)
      ${dryRun ? '' : 'FOR UPDATE OF review,action'}
    `, [audit.id, detail.actionId, audit.artifact_id, detail.after.project_id, detail.after.project_name, detail.after.project_unresolved])).rows;
    if (current.length !== 1) throw new Error('Reversión cancelada: una acción cambió después del vínculo, fue revisada o ya pertenece al nuevo flujo.');
    changes.push({ auditId: audit.id, actionId: detail.actionId, artifactId: audit.artifact_id, before: detail.after, after: detail.before });
  }
  if (!dryRun) {
    for (const change of changes) {
      await client.query('UPDATE meeting_review_actions SET project_id=$2,project_name=$3,project_unresolved=$4,updated_at=NOW() WHERE id=$1',
        [change.actionId, change.after.project_id, change.after.project_name, change.after.project_unresolved]);
      await client.query("INSERT INTO meeting_review_versions(id,artifact_id,actor,stage,detail) VALUES($1,$2,'server-operator','project-link-reverted',$3)",
        [randomUUID(), change.artifactId, JSON.stringify({ ...change, reason: reason.trim() })]);
    }
  }
  return changes;
}
