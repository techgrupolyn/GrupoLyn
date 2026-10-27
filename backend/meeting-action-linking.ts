import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { PoolClient } from 'pg';

export type ActionDirectoryPerson = { id: string; kind: 'employee' | 'client'; name: string };

function nameTokens(value: string): string[] {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

export function matchActionResponsible(name: string, directory: ActionDirectoryPerson[]): ActionDirectoryPerson | null {
  if (/[,;&/]|\s(?:y|e|and)\s/i.test(name)) return null;
  const tokens = nameTokens(name);
  if (tokens.length < 2 || tokens.some((token) => ['grupo', 'equipo', 'cliente', 'clientes', 'propietarios', 'pendiente', 'asignar'].includes(token))) return null;
  const candidates = directory.filter((person) => {
    const candidate = nameTokens(person.name);
    if (candidate.length < 2) return false;
    const shorter = tokens.length <= candidate.length ? tokens : candidate;
    const longer = tokens.length <= candidate.length ? candidate : tokens;
    return shorter.every((token, index) => token === longer[index]);
  });
  const unique = new Map(candidates.map((person) => [`${person.kind}:${person.id}`, person]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

export async function linkUnassignedMeetingActions(client: PoolClient, options: { dryRun?: boolean; artifactId?: string; skipPending?: boolean } = {}) {
  const directory = await client.query<ActionDirectoryPerson>(`
    SELECT id, 'employee' AS kind, CONCAT_WS(' ', nombre, apellido) AS name FROM empleados WHERE activo = TRUE
    UNION ALL
    SELECT id, 'client' AS kind, CONCAT_WS(' ', nombre, apellido) AS name FROM clientes WHERE activo = TRUE
  `);
  const actions = await client.query<{ id: string; artifact_id: string; responsible: string; before: Record<string, unknown> }>(`
    SELECT action.id, action.artifact_id, action.responsible, to_jsonb(action) AS before
    FROM meeting_review_actions action
    WHERE action.status = 'pending' AND action.responsible_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM meeting_project_drafts draft WHERE draft.artifact_id=action.artifact_id)
      AND COALESCE(action.responsible_source, 'automatic') <> 'manual'
      AND NULLIF(BTRIM(action.responsible), '') IS NOT NULL
      AND ($1::uuid IS NULL OR action.artifact_id = $1)
      AND NOT EXISTS (SELECT 1 FROM meeting_reviews review WHERE review.artifact_id = action.artifact_id AND review.analysis_status = 'processing')
      AND (NOT $2::boolean OR NOT EXISTS (SELECT 1 FROM meeting_reviews review WHERE review.artifact_id = action.artifact_id AND review.analysis_status = 'pending' AND review.manual_revision = FALSE))
      AND NOT EXISTS (SELECT 1 FROM meeting_review_action_responsibles linked WHERE linked.action_id = action.id)
    ORDER BY action.id ${options.dryRun ? '' : 'FOR UPDATE OF action'}
  `, [options.artifactId || null, Boolean(options.skipPending)]);
  const linked: Array<{ actionId: string; original: string; person: ActionDirectoryPerson }> = [];
  const audit = new Map<string, Array<{ action_before: Record<string, unknown>; linked_to: ActionDirectoryPerson }>>();
  for (const action of actions.rows) {
    await yieldToEventLoop();
    const person = matchActionResponsible(action.responsible, directory.rows);
    if (!person) continue;
    if (!options.dryRun) {
      await client.query(`UPDATE meeting_review_actions SET responsible_id = $2, responsible_kind = $3,
        responsible_role = COALESCE($4, responsible_role), responsible_source = 'automatic', match_confidence = 'high', updated_at = NOW()
        WHERE id = $1`, [action.id, person.id, person.kind, person.kind === 'client' ? 'Cliente' : null]);
      await client.query(`INSERT INTO meeting_review_action_responsibles
        (action_id, responsible_kind, responsible_id, employee_id, responsible_name, responsible_role, match_confidence)
        VALUES ($1, $2, $3, $4, $5, $6, 'high')`,
      [action.id, person.kind, person.id, person.kind === 'employee' ? person.id : null, person.name, person.kind === 'client' ? 'Cliente' : null]);
      const changes = audit.get(action.artifact_id) || [];
      changes.push({ action_before: action.before, linked_to: person });
      audit.set(action.artifact_id, changes);
    }
    linked.push({ actionId: action.id, original: action.responsible, person });
  }
  for (const [artifactId, changes] of audit) {
    await client.query(`INSERT INTO meeting_review_versions (id, artifact_id, actor, stage, detail)
      VALUES ($1, $2, 'directory-linker', 'responsible-linked', $3)`,
    [randomUUID(), artifactId, JSON.stringify({ rule: 'unique-normalized-name-prefix-v1', changes })]);
  }
  return { scanned: actions.rows.length, linked };
}
