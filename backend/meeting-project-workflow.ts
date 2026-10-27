import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { projectMeetingList } from './meeting-project-list.ts';
import { recordingState, type RecordingAccess } from './meeting-recordings.ts';
import type { Pool, PoolClient } from 'pg';
import type { Express, Request } from 'express';
import { designatedProjectSnapshot, latestProjectReviewers, canReviewBranch, canSeeProjectBranch, resolveProjectResponsible, type ProjectBranch, type ProjectPerson, type ProjectPosition, type ProjectSnapshot, type ProjectReviewerSelection } from './meeting-project-policy.ts';

type Session = { id?: number; usuario?: string; rol?: string };
type Actor = { userId: number; employeeId: string; director: boolean; admin: boolean };
type Branch = ProjectBranch & { artifact_id: string; project_name: string; initial_snapshot: ProjectSnapshot; updated_at: string };
type Action = { responsibles?: { responsible_kind: string; responsible_id: string; name: string; role: string }[]; id: string; artifact_id: string; project_id: string | null; project_name: string | null; title: string; responsible: string | null; responsible_id: string | null; responsible_kind: string | null; responsible_source: string; assignment_origin: string | null; mentioned_responsible: string | null; due_date: string | null; source_ref: string | null; escalated_at: string | null; updated_at: string; status: string };
type Queryable = Pick<PoolClient, 'query'>;
const actionResponsiblesSql = `COALESCE((SELECT jsonb_agg(jsonb_build_object('responsible_kind',person.responsible_kind,'responsible_id',person.responsible_id,'name',person.responsible_name,'role',person.responsible_role) ORDER BY person.responsible_name)
  FROM meeting_review_action_responsibles person WHERE person.action_id=action.id),'[]'::jsonb) AS responsibles`;

export async function ensureProjectMeetingSchema(database: Queryable) {
  await database.query(`
    CREATE TABLE IF NOT EXISTS meeting_project_feature (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO meeting_project_feature(singleton) VALUES(TRUE) ON CONFLICT DO NOTHING;
    ALTER TABLE meeting_project_feature ADD COLUMN IF NOT EXISTS directory_available BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE TABLE IF NOT EXISTS meeting_project_reviewer_settings (
      project_id VARCHAR(255) PRIMARY KEY REFERENCES proyectos(id) ON DELETE CASCADE,
      selection JSONB NOT NULL, updated_by TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS meeting_project_drafts (
      artifact_id UUID PRIMARY KEY REFERENCES meeting_reviews(artifact_id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS meeting_project_branches (
      id UUID PRIMARY KEY, artifact_id UUID NOT NULL REFERENCES meeting_project_drafts(artifact_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL, project_name TEXT NOT NULL, snapshot JSONB NOT NULL, initial_snapshot JSONB NOT NULL,
      cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0), approved BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(artifact_id, project_id)
    );
    ALTER TABLE meeting_review_actions ADD COLUMN IF NOT EXISTS assignment_origin TEXT;
    ALTER TABLE meeting_review_actions ADD COLUMN IF NOT EXISTS mentioned_responsible TEXT;
    ALTER TABLE meeting_review_actions ADD COLUMN IF NOT EXISTS escalated_by TEXT;
    ALTER TABLE meeting_review_actions ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS meeting_project_audit (
      id BIGSERIAL PRIMARY KEY, artifact_id UUID, project_id TEXT, actor_id TEXT NOT NULL,
      operation TEXT NOT NULL, detail JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS meeting_project_audit_artifact_idx ON meeting_project_audit(artifact_id, id);
  `);
}

export async function projectMeetingsEnabled(database: Queryable): Promise<boolean> {
  return Boolean((await database.query('SELECT enabled FROM meeting_project_feature WHERE singleton = TRUE')).rows[0]?.enabled);
}

async function audit(database: Queryable, artifactId: string | null, projectId: string | null, actor: string, operation: string, detail: unknown) {
  await database.query('INSERT INTO meeting_project_audit(artifact_id,project_id,actor_id,operation,detail) VALUES($1,$2,$3,$4,$5::jsonb)', [artifactId, projectId, actor, operation, JSON.stringify(detail)]);
  if (artifactId && operation !== 'denied') {
    await database.query("SELECT set_config('lyn.audit_actor_id',$1,TRUE), set_config('lyn.audit_actor_role','project-workflow',TRUE)", [actor]);
    await database.query('INSERT INTO meeting_review_versions(id,artifact_id,actor,stage,detail) VALUES($1,$2,$3,$4,$5)', [randomUUID(), artifactId, actor, operation, JSON.stringify(detail)]);
  }
}

export async function projectDirectory(database: Queryable, projectId: string) {
  const positions = await database.query<ProjectPosition>(`
    SELECT cargo.id, cargo.nombre AS name, cargo.cargo_padre_id AS "parentId", cargo.es_direccion AS director,
      CASE WHEN cargo.tipo_equipo_proyecto IS NOT NULL THEN cargo.tipo_equipo_proyecto='pmc' ELSE
      EXISTS(SELECT 1 FROM organigrama_cargo_roles roles WHERE roles.cargo_id=cargo.id AND LOWER(roles.rol) IN ('pmc','jefe_de_proyectos'))
      OR LOWER(COALESCE(cargo.codigo,'')) IN ('pmc','jefe_de_proyectos')
      OR LOWER(BTRIM(cargo.nombre)) IN ('pmc','pmc / proyectos','jefe de proyectos') END AS final
    FROM organigrama_cargos cargo WHERE cargo.activo=TRUE ORDER BY cargo.id`);
  const team = await database.query<ProjectPerson>(`
    SELECT employee.id, CONCAT_WS(' ', employee.nombre, employee.apellido) AS name,
      COALESCE(ARRAY_AGG(DISTINCT assignment.cargo_id ORDER BY assignment.cargo_id) FILTER(WHERE assignment.cargo_id IS NOT NULL),'{}') AS "cargoIds",
      COALESCE(jsonb_object_agg(assignment.cargo_id,assignment.assigned_at) FILTER(WHERE assignment.cargo_id IS NOT NULL),'{}'::jsonb) AS "assignedAt"
    FROM (
      SELECT empleado_id FROM proyecto_asignaciones WHERE proyecto_id=$1
      UNION SELECT empleado_id FROM organigrama_cargo_asignaciones WHERE proyecto_id=$1 AND activo=TRUE
    ) members JOIN empleados employee ON employee.id=members.empleado_id
    LEFT JOIN LATERAL (
      SELECT dated.cargo_id, MAX(dated.assigned_at) AS assigned_at FROM (
      SELECT assigned.cargo_id, assigned.source_assigned_at AS assigned_at
      FROM organigrama_cargo_asignaciones assigned WHERE assigned.empleado_id=employee.id AND assigned.activo=TRUE
        AND assigned.proyecto_id=$1
      UNION
      SELECT cargo.id, membership.source_created_at FROM proyecto_asignaciones membership JOIN organigrama_cargos cargo ON cargo.activo=TRUE AND (
        CASE WHEN cargo.tipo_equipo_proyecto IS NOT NULL THEN cargo.tipo_equipo_proyecto =
          CASE LOWER(BTRIM(membership.rol_en_proyecto)) WHEN 'planimetrista' THEN 'delineante' ELSE LOWER(BTRIM(membership.rol_en_proyecto)) END
        ELSE LOWER(BTRIM(membership.rol_en_proyecto))=LOWER(BTRIM(cargo.codigo)) OR LOWER(BTRIM(membership.rol_en_proyecto))=LOWER(BTRIM(cargo.nombre)) END)
      WHERE membership.proyecto_id=$1 AND membership.empleado_id=employee.id
      ) dated GROUP BY dated.cargo_id
    ) assignment ON TRUE
    WHERE employee.activo=TRUE
    GROUP BY employee.id ORDER BY employee.id`, [projectId]);
  return { team: team.rows, positions: positions.rows };
}

async function projectSnapshot(database: Queryable, projectId: string): Promise<ProjectSnapshot> {
  const { team, positions } = await projectDirectory(database, projectId);
  if (!(await database.query('SELECT 1 FROM proyectos WHERE id=$1 AND activo=TRUE', [projectId])).rowCount) return { team, path: [], pmcId: null, issue: 'La obra está inactiva o ya no existe. Revisa su vinculación antes de aprobar.' };
  const available = (await database.query('SELECT directory_available FROM meeting_project_feature WHERE singleton=TRUE')).rows[0]?.directory_available;
  if (!available) return { team, path: [], pmcId: null, issue: 'Club LYN no disponible: se reintentará tras sincronizar el directorio.' };
  const setting = (await database.query('SELECT selection FROM meeting_project_reviewer_settings WHERE project_id=$1', [projectId])).rows[0];
  return designatedProjectSnapshot(team, positions, setting?.selection);
}

export async function syncProjectMeeting(database: Queryable, artifactId: string) {
  if (!await projectMeetingsEnabled(database)) return;
  const review = (await database.query('SELECT * FROM meeting_reviews WHERE artifact_id=$1 FOR UPDATE', [artifactId])).rows[0];
  if (!await projectMeetingsEnabled(database)) return;
  if (!review || review.analysis_status !== 'completed') return;
  if (review.status === 'approved' && (await database.query('SELECT 1 FROM meeting_project_drafts WHERE artifact_id=$1',[artifactId])).rowCount) return;
  if (!(await database.query('SELECT directory_available FROM meeting_project_feature WHERE singleton=TRUE')).rows[0]?.directory_available
    && (await database.query('SELECT 1 FROM meeting_project_drafts WHERE artifact_id=$1',[artifactId])).rowCount) return;
  const inserted = await database.query('INSERT INTO meeting_project_drafts(artifact_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING artifact_id', [artifactId]);
  const actions = (await database.query<Action>('SELECT * FROM meeting_review_actions WHERE artifact_id=$1 ORDER BY created_at,id', [artifactId])).rows;
  const projects = new Set(actions.map((action) => action.project_id || ''));
  if (!projects.size) projects.add(review.project_id || '');
  const branches: Branch[] = [];
  let changed = Boolean(inserted.rowCount);
  if (review.status !== 'approved') {
    const removed = await database.query('DELETE FROM meeting_project_branches WHERE artifact_id=$1 AND NOT (project_id=ANY($2::text[])) RETURNING *', [artifactId, [...projects]]);
    if (removed.rowCount) {
      changed = true;
      await audit(database, artifactId, null, 'directory-sync', 'obsolete-branches-removed', { before: removed.rows });
    }
  }
  for (const projectId of projects) {
    const snapshot = projectId ? await projectSnapshot(database, projectId) : { team: [], path: [], pmcId: null, issue: 'Acciones sin proyecto: vincular antes de revisar.' };
    const projectName = projectId ? (await database.query('SELECT nombre FROM proyectos WHERE id=$1', [projectId])).rows[0]?.nombre || projectId : 'Sin proyecto';
    let branch = (await database.query<Branch>('SELECT * FROM meeting_project_branches WHERE artifact_id=$1 AND project_id=$2', [artifactId, projectId])).rows[0];
    if (!branch) {
      branch = (await database.query<Branch>('INSERT INTO meeting_project_branches(id,artifact_id,project_id,project_name,snapshot,initial_snapshot) VALUES($1,$2,$3,$4,$5::jsonb,$5::jsonb) RETURNING *', [randomUUID(), artifactId, projectId, projectName, JSON.stringify(snapshot)])).rows[0];
      changed = true;
    } else if (!isDeepStrictEqual(branch.snapshot, snapshot)) {
      await audit(database, artifactId, projectId, 'directory-sync', 'team-changed', { before: branch.snapshot, after: snapshot });
      branch = (await database.query<Branch>('UPDATE meeting_project_branches SET snapshot=$2::jsonb,cursor=0,approved=FALSE,updated_at=NOW() WHERE id=$1 RETURNING *', [branch.id, JSON.stringify(snapshot)])).rows[0];
      changed = true;
    }
    branches.push(branch);
  }
  if (review.status === 'approved') {
    await database.query('UPDATE meeting_project_branches SET approved=TRUE,cursor=GREATEST(jsonb_array_length(snapshot->\'path\')-1,0) WHERE artifact_id=$1',[artifactId]);
    await audit(database, artifactId, null, 'directory-sync', 'historical-scope-captured', { note: 'Ámbito de consulta capturado al habilitar el flujo. El resultado aprobado no se modifica.' });
    return;
  }
  for (const action of actions) {
    const branch = branches.find((candidate) => candidate.project_id === (action.project_id || ''))!;
    if (action.responsible_source === 'manual' || action.assignment_origin === 'manual') {
      await database.query("UPDATE meeting_review_actions SET assignment_origin='manual' WHERE id=$1 AND assignment_origin IS DISTINCT FROM 'manual'", [action.id]);
      continue;
    }
    const mentioned = action.mentioned_responsible ?? (action.assignment_origin ? null : action.responsible);
    const resolution = resolveProjectResponsible(mentioned, branch.snapshot);
    if (action.assignment_origin === resolution.origin && action.responsible_id === (resolution.person?.id || null)) continue;
    await database.query(`UPDATE meeting_review_actions SET assignment_origin=$2,mentioned_responsible=$3,responsible_id=$4,
      responsible=$5,responsible_kind=CASE WHEN $4::varchar IS NOT NULL THEN 'employee' END,responsible_source='automatic',updated_at=NOW() WHERE id=$1`,
    [action.id, resolution.origin, mentioned, resolution.person?.id || null, resolution.person?.name || null]);
    await database.query('DELETE FROM meeting_review_action_responsibles WHERE action_id=$1', [action.id]);
    await audit(database, artifactId, action.project_id, 'directory-sync', 'responsible-resolved', { actionId: action.id, before: action.responsible_id, after: resolution.person?.id || null, origin: resolution.origin });
    changed = true;
  }
  if (changed) {
    await database.query('UPDATE meeting_project_branches SET approved=FALSE WHERE artifact_id=$1', [artifactId]);
    await database.query("UPDATE meeting_reviews SET workflow_stage='project_branches',workflow_recipient_id=NULL,status='pending',manual_revision=TRUE,updated_at=NOW() WHERE artifact_id=$1", [artifactId]);
    await audit(database, artifactId, null, 'directory-sync', 'branches-synced', { projects: [...projects] });
  }
}

export async function refreshProjectMeetings(pool: Pool) {
  if (!await projectMeetingsEnabled(pool)) return;
  const reviews = await pool.query("SELECT artifact_id FROM meeting_reviews review WHERE analysis_status='completed' AND (status<>'approved' OR NOT EXISTS(SELECT 1 FROM meeting_project_drafts draft WHERE draft.artifact_id=review.artifact_id)) ORDER BY artifact_id");
  for (const review of reviews.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await syncProjectMeeting(client, review.artifact_id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}

async function validateProjectMeetingActivation(database: Queryable) {
  const directory = (await database.query('SELECT directory_available FROM meeting_project_feature WHERE singleton=TRUE')).rows[0];
  if (!directory?.directory_available) throw new WorkflowError(409, 'No se activa el flujo: primero debe completarse la sincronización de Club LYN.');
  const unlinked = await database.query(`SELECT COUNT(*)::int AS count FROM meeting_reviews review
    WHERE review.analysis_status='completed' AND review.status<>'approved' AND (
      EXISTS(SELECT 1 FROM meeting_review_actions action WHERE action.artifact_id=review.artifact_id AND NULLIF(BTRIM(action.project_id),'') IS NULL)
      OR (NULLIF(BTRIM(review.project_id),'') IS NULL AND NOT EXISTS(SELECT 1 FROM meeting_review_actions action WHERE action.artifact_id=review.artifact_id)))`);
  if (unlinked.rows[0].count) throw new WorkflowError(409, `No se activa el flujo: ${unlinked.rows[0].count} reuniones requieren vincular sus obras. No se ha cambiado el flujo anterior.`);
  const projects = await database.query(`SELECT DISTINCT action.project_id FROM meeting_review_actions action
    JOIN meeting_reviews review ON review.artifact_id=action.artifact_id WHERE review.analysis_status='completed' AND review.status<>'approved'
    UNION SELECT review.project_id FROM meeting_reviews review WHERE review.analysis_status='completed' AND review.status<>'approved'
      AND NOT EXISTS(SELECT 1 FROM meeting_review_actions action WHERE action.artifact_id=review.artifact_id)`);
  let blocked = 0;
  for (const project of projects.rows) if ((await projectSnapshot(database, project.project_id)).issue) blocked++;
  if (blocked) throw new WorkflowError(409, `No se activa el flujo: ${blocked} proyectos necesitan una cadena de revisión inequívoca con cargos asignados en Club LYN. No se ha cambiado el flujo anterior.`);
}

async function actorFromSession(pool: Pool, session: Session): Promise<Actor> {
  const account = (await pool.query('SELECT rol FROM usuarios WHERE id=$1 AND activo=TRUE', [session.id || null])).rows[0];
  if (!account) throw new WorkflowError(403, 'La cuenta no está activa.');
  const employees = await pool.query(`SELECT employee.id FROM usuarios account JOIN empleados employee ON LOWER(employee.email)=LOWER(account.email)
    WHERE account.id=$1 AND account.activo=TRUE AND employee.activo=TRUE`, [session.id || null]);
  const employeeId = employees.rows.length === 1 ? employees.rows[0].id : '';
  const director = employeeId ? (await pool.query(`SELECT 1 FROM organigrama_cargo_asignaciones assignment
    JOIN organigrama_cargos cargo ON cargo.id=assignment.cargo_id AND cargo.activo=TRUE
    WHERE assignment.empleado_id=$1 AND assignment.activo=TRUE AND (LOWER(cargo.codigo) IN ('director','director_general') OR LOWER(cargo.nombre) IN ('director','director general')) LIMIT 1`, [employeeId])).rowCount === 1 : false;
  return { userId: session.id || 0, employeeId, director, admin: ['superadmin','admin'].includes(account.rol || '') };
}

function visibleAction(action: Action, branch: Branch | undefined, branches: Branch[], actor: Actor) {
  if (actor.director) return Boolean(action.escalated_at || (action.responsible_kind === 'employee' && action.responsible_id === actor.employeeId) || action.responsibles?.some((person) => person.responsible_kind === 'employee' && person.responsible_id === actor.employeeId));
  return Boolean(branch && canSeeProjectBranch(branch, branches, actor.employeeId));
}

class WorkflowError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function registerProjectMeetingRoutes(app: Express, pool: Pool, readSession: (req: Request) => Session | null, recordings?: RecordingAccess) {
  app.use('/api/project-meetings', async (req, res) => {
    let client: PoolClient | undefined;
    let actor: Actor | undefined;
    let artifactId: string | null = null;
    try {
      const session = readSession(req);
      if (!session) throw new WorkflowError(401, 'Inicia sesión para acceder a reuniones.');
      actor = await actorFromSession(pool, session);
      const enabled = await projectMeetingsEnabled(pool);
      const enrolled = Boolean((await pool.query('SELECT 1 FROM meeting_project_drafts LIMIT 1')).rowCount);
      if (req.path === '/mode' && req.method === 'GET') return void res.json({ enabled, enrolled, can_configure_reviewers: actor.admin });
      if (req.path === '/resolution' || req.path.startsWith('/resolution/')) {
        if (!actor.admin) throw new WorkflowError(403, 'Solo administración puede resolver vinculaciones pendientes.');
        if (req.path === '/resolution' && req.method === 'GET') {
          const page = Math.max(1, Math.min(100000, Number.parseInt(String(req.query.page || '1'), 10) || 1));
          const rows = await pool.query(`SELECT review.artifact_id AS id,artifact.name,
            COUNT(action.id)::int AS unlinked_actions,COUNT(*) OVER()::int AS total
            FROM meeting_reviews review JOIN google_drive_artifacts artifact ON artifact.id=review.artifact_id
            LEFT JOIN meeting_review_actions action ON action.artifact_id=review.artifact_id AND NULLIF(BTRIM(action.project_id),'') IS NULL
            WHERE review.analysis_status='completed' AND review.status<>'approved'
              AND (action.id IS NOT NULL OR (NULLIF(BTRIM(review.project_id),'') IS NULL AND NOT EXISTS(SELECT 1 FROM meeting_review_actions existing WHERE existing.artifact_id=review.artifact_id)))
            GROUP BY review.artifact_id,artifact.name ORDER BY artifact.name,review.artifact_id LIMIT 20 OFFSET $1`, [(page - 1) * 20]);
          return void res.json({ items: rows.rows, page, total: rows.rows[0]?.total || 0 });
        }
        artifactId = req.path.slice('/resolution/'.length);
        if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(artifactId)) throw new WorkflowError(404, 'Reunión no encontrada.');
        if (!['GET', 'PUT'].includes(req.method)) throw new WorkflowError(405, 'Método no permitido.');
        const readOnly = req.method === 'GET';
        client = await pool.connect();
        await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
        if (readOnly) await client.query("SET LOCAL statement_timeout='15s'");
        const review = (await client.query(`SELECT * FROM meeting_reviews WHERE artifact_id=$1 ${readOnly ? '' : 'FOR UPDATE'}`, [artifactId])).rows[0];
        if (!review) throw new WorkflowError(404, 'Reunión no encontrada.');
        if (review.status === 'approved' || review.analysis_status !== 'completed') throw new WorkflowError(409, 'Solo se pueden vincular análisis terminados y pendientes de aprobación.');
        const actions = (await client.query(`SELECT id,title,project_id,project_name,source_ref FROM meeting_review_actions WHERE artifact_id=$1 ORDER BY created_at,id ${readOnly ? '' : 'FOR UPDATE'}`, [artifactId])).rows;
        if (req.method === 'GET') {
          const name = (await client.query('SELECT name FROM google_drive_artifacts WHERE id=$1', [artifactId])).rows[0]?.name;
          await client.query('COMMIT');
          return void res.json({ id: artifactId, name, actions: actions.filter((action) => !action.project_id?.trim()), noActions: !actions.length });
        }
        if (req.method !== 'PUT') throw new WorkflowError(405, 'Método no permitido.');
        if (!(await client.query('SELECT directory_available FROM meeting_project_feature WHERE singleton=TRUE')).rows[0]?.directory_available) throw new WorkflowError(409, 'Sincroniza el directorio antes de vincular obras.');
        const reason = String(req.body.reason || '').trim();
        const ids = req.body.actionIds;
        if (!reason || !Array.isArray(ids) || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length || (actions.length && !ids.length)) throw new WorkflowError(400, 'Selecciona las acciones e indica el motivo de la vinculación.');
        const selected = actions.filter((action) => ids.includes(action.id) && !action.project_id?.trim());
        if (selected.length !== ids.length || (!actions.length && review.project_id)) throw new WorkflowError(409, 'La selección cambió o contiene acciones ya vinculadas. Actualiza la lista.');
        const project = (await client.query('SELECT id,nombre FROM proyectos WHERE id=$1 AND activo=TRUE FOR SHARE', [req.body.projectId])).rows[0];
        if (!project) throw new WorkflowError(400, 'Selecciona una obra activa.');
        await client.query("UPDATE meeting_review_actions SET project_id=$2,project_name=$3,project_unresolved=FALSE,updated_at=NOW() WHERE id=ANY($1::uuid[])", [ids, project.id, project.nombre]);
        if (!actions.length) await client.query('UPDATE meeting_reviews SET project_id=$2,project_name=$3,updated_at=NOW() WHERE artifact_id=$1', [artifactId, project.id, project.nombre]);
        await audit(client, artifactId, project.id, String(actor.userId), 'projects-linked-manually', { before: selected, beforeMeetingProject: review.project_id, after: project, reason });
        await syncProjectMeeting(client, artifactId);
        await client.query('UPDATE meeting_project_branches SET cursor=0,approved=FALSE,updated_at=NOW() WHERE artifact_id=$1 AND project_id=$2', [artifactId, project.id]);
        await client.query('UPDATE meeting_project_branches SET approved=FALSE WHERE artifact_id=$1', [artifactId]);
        await client.query("UPDATE meeting_reviews SET status='pending',manual_revision=TRUE,updated_at=NOW() WHERE artifact_id=$1", [artifactId]);
        await client.query('COMMIT');
        return void res.json({ ok: true, linked: selected.length });
      }
      if (req.path === '/reviewers' || req.path.startsWith('/reviewers/')) {
        if (!actor.admin) throw new WorkflowError(403, 'Solo administración puede designar revisores del dashboard.');
        if (req.path === '/reviewers' && req.method === 'GET') return void res.json((await pool.query('SELECT id,nombre AS name FROM proyectos WHERE activo=TRUE ORDER BY nombre,id')).rows);
        const projectId = decodeURIComponent(req.path.slice('/reviewers/'.length));
        client = await pool.connect();
        await client.query('BEGIN');
        const project = (await client.query('SELECT id,nombre AS name FROM proyectos WHERE id=$1 AND activo=TRUE FOR UPDATE', [projectId])).rows[0];
        if (!project) throw new WorkflowError(404, 'Obra no encontrada.');
        const directory = await projectDirectory(client, projectId);
        const previous = (await client.query('SELECT selection FROM meeting_project_reviewer_settings WHERE project_id=$1', [projectId])).rows[0]?.selection || null;
        if (req.method === 'GET') {
          await client.query('COMMIT');
          return void res.json({ ...project, ...directory, selection: previous, automaticReviewers: latestProjectReviewers(directory.team), snapshot: designatedProjectSnapshot(directory.team, directory.positions, previous) });
        }
        if (req.method !== 'PUT') throw new WorkflowError(405, 'Método no permitido.');
        if (!(await client.query('SELECT directory_available FROM meeting_project_feature WHERE singleton=TRUE')).rows[0]?.directory_available) throw new WorkflowError(409, 'Sincroniza el directorio antes de designar revisores.');
        const selection = req.body.selection as ProjectReviewerSelection;
        const reason = String(req.body.reason || '').trim();
        if (!reason || !selection || typeof selection !== 'object' || !selection.reviewers || typeof selection.reviewers !== 'object' || Array.isArray(selection.reviewers)
          || (selection.startCargoId !== null && typeof selection.startCargoId !== 'string')) throw new WorkflowError(400, 'Indica la designación y el motivo.');
        if (selection.fallbackPmc) throw new WorkflowError(400, 'El PMC debe estar asignado como PMC en esta obra en Club LYN; no se pueden trasladar cargos globales o de otras obras.');
        for (const [cargoId, employeeId] of Object.entries(selection.reviewers)) {
          if (typeof employeeId !== 'string' || !directory.positions.some((position) => position.id === cargoId && !position.director)
            || !directory.team.some((person) => person.id === employeeId && person.cargoIds.includes(cargoId))) throw new WorkflowError(400, 'Cada revisor debe ocupar ese cargo en el equipo vinculado a la obra.');
        }
        if (selection.startCargoId && !directory.team.some((person) => person.cargoIds.includes(selection.startCargoId!))) throw new WorkflowError(400, 'El primer cargo no tiene una persona vinculada a esta obra.');
        const snapshot = designatedProjectSnapshot(directory.team, directory.positions, selection);
        if (snapshot.issue) throw new WorkflowError(409, snapshot.issue);
        await client.query(`INSERT INTO meeting_project_reviewer_settings(project_id,selection,updated_by) VALUES($1,$2::jsonb,$3)
          ON CONFLICT(project_id) DO UPDATE SET selection=EXCLUDED.selection,updated_by=EXCLUDED.updated_by,updated_at=NOW()`, [projectId,JSON.stringify(selection),String(actor.userId)]);
        await audit(client, null, projectId, String(actor.userId), 'reviewers-designated', { before: previous, after: selection, reason });
        const affected = await client.query(`SELECT review.artifact_id FROM meeting_reviews review WHERE review.status<>'approved' AND review.analysis_status='completed'
          AND (review.project_id=$1 OR EXISTS(SELECT 1 FROM meeting_review_actions action WHERE action.artifact_id=review.artifact_id AND action.project_id=$1)) ORDER BY review.artifact_id`, [projectId]);
        for (const review of affected.rows) await syncProjectMeeting(client, review.artifact_id);
        await client.query('COMMIT');
        return void res.json({ ok: true, snapshot, ...directory, automaticReviewers: latestProjectReviewers(directory.team), pendingMeetings: affected.rowCount });
      }
      if (req.path === '/mode' && req.method === 'PUT') {
        if (!actor.admin) throw new WorkflowError(403, 'Solo administración puede cambiar la configuración.');
        if (typeof req.body.enabled !== 'boolean') throw new WorkflowError(400, 'enabled debe ser booleano.');
        client = await pool.connect();
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
        await client.query('LOCK TABLE meeting_reviews,meeting_review_actions,meeting_project_feature IN SHARE ROW EXCLUSIVE MODE');
        const wasEnabled = await projectMeetingsEnabled(client);
        if (req.body.enabled && !wasEnabled) await validateProjectMeetingActivation(client);
        await client.query('UPDATE meeting_project_feature SET enabled=$1,updated_at=NOW()', [req.body.enabled]);
        await audit(client, null, null, String(actor.userId), 'feature-changed', { enabled: req.body.enabled });
        if (req.body.enabled) {
          const reviews = await client.query("SELECT artifact_id FROM meeting_reviews WHERE analysis_status='completed' ORDER BY artifact_id");
          for (const review of reviews.rows) await syncProjectMeeting(client, review.artifact_id);
        }
        await client.query('COMMIT');
        return void res.json({ enabled: req.body.enabled });
      }
      if (!enabled && req.method !== 'GET') throw new WorkflowError(409, 'El nuevo flujo está pausado. Los borradores se conservan sin cambios.');
      if (!actor.employeeId) throw new WorkflowError(403, 'Esta cuenta no tiene un empleado activo vinculado.');
      const parts = req.path.split('/').filter(Boolean);
      if (!parts.length && req.method === 'GET') {
        const branches = (await pool.query<Branch>('SELECT * FROM meeting_project_branches ORDER BY artifact_id,project_id')).rows;
        const actions = (await pool.query<Action>(`SELECT action.*,${actionResponsiblesSql} FROM meeting_review_actions action JOIN meeting_project_drafts draft ON draft.artifact_id=action.artifact_id`)).rows;
        const visibleIds = new Set<string>();
        for (const branch of branches) {
          const siblings = branches.filter((candidate) => candidate.artifact_id === branch.artifact_id);
          if (!actor.director && canSeeProjectBranch(branch, siblings, actor.employeeId)) visibleIds.add(branch.artifact_id);
        }
        const visibleActions = actions.filter((action) => visibleAction(action, branches.find((branch) => branch.artifact_id === action.artifact_id && branch.project_id === (action.project_id || '')), branches.filter((branch) => branch.artifact_id === action.artifact_id), actor!));
        for (const action of visibleActions) visibleIds.add(action.artifact_id);
        const reviews = await pool.query(`SELECT review.artifact_id AS id,review.status,review.meeting_date::text,review.meeting_kind,review.updated_at,review.contact_id,review.contact_name,artifact.name
          FROM meeting_reviews review JOIN google_drive_artifacts artifact ON artifact.id=review.artifact_id WHERE review.artifact_id=ANY($1::uuid[]) ORDER BY review.updated_at DESC`, [[...visibleIds]]);
        const items = reviews.rows.map((review) => {
          const siblings = branches.filter((branch) => branch.artifact_id === review.id);
          const accessible = siblings.filter((branch) => !actor!.director && canSeeProjectBranch(branch, siblings, actor!.employeeId));
          const names = actor!.director ? [...new Set(visibleActions.filter((action) => action.artifact_id === review.id).map((action) => action.project_name))] : accessible.map((branch) => branch.project_name);
          const fullScope = accessible.length === siblings.length && !actor!.director;
          const scopedActions = visibleActions.filter((action) => action.artifact_id === review.id);
          const scopedBranches = actor!.director ? siblings.filter((branch) => scopedActions.some((action) => action.project_id === branch.project_id)) : accessible;
          const pmcs = [...new Map(scopedBranches.flatMap((branch) => branch.snapshot.team.filter((person) => person.id === branch.snapshot.pmcId)).map((person) => [person.id, person])).values()];
          return { ...review, name: fullScope ? review.name : `Reunión · ${names.filter(Boolean).join(' / ')}`,
            contact_id: fullScope ? review.contact_id : null, contact_name: fullScope ? review.contact_name : null,
            projects: scopedBranches.map((branch) => ({ id: branch.project_id, nombre: branch.project_name })),
            project_name: names.filter(Boolean).join(' / '), project_id: scopedBranches[0]?.project_id || null,
            pmc: pmcs[0]?.name || null, pmc_employee_id: pmcs[0]?.id || null,
            pmc_assignments: pmcs.map((person) => ({ employee_id: person.id, name: person.name })), pmcs: pmcs.map((person) => person.name),
            roles: [...new Set(scopedBranches.flatMap((branch) => branch.snapshot.path.map((step) => step.cargo)))],
            awaiting: enabled && review.status !== 'approved' && accessible.some((branch) => canReviewBranch(branch, siblings, actor!.employeeId)),
            review_steps: actor!.director ? [] : scopedBranches.map((branch) => ({ project: branch.project_name, approved: branch.approved, issue: branch.snapshot.issue, reviewer: branch.snapshot.path[branch.cursor]?.name, cargo: branch.snapshot.path[branch.cursor]?.cargo })),
            workflow_stage: 'project_branches', analysis_status: 'completed', actions_count: scopedActions.length,
            actions_without_responsible: scopedActions.filter((action) => !action.responsible_id).length,
            actions_without_due_date: scopedActions.filter((action) => !action.due_date).length };
        });
        if (actor.admin && !actor.director) {
          const exceptions = await pool.query(`SELECT review.artifact_id AS id,artifact.name,review.status,review.meeting_date::text,review.updated_at,
            COUNT(action.id)::int AS actions_count,
            COUNT(action.id) FILTER (WHERE action.responsible_id IS NULL)::int AS actions_without_responsible,
            COUNT(action.id) FILTER (WHERE action.due_date IS NULL)::int AS actions_without_due_date
            FROM meeting_reviews review JOIN google_drive_artifacts artifact ON artifact.id=review.artifact_id
            LEFT JOIN meeting_review_actions action ON action.artifact_id=review.artifact_id AND NULLIF(BTRIM(action.project_id),'') IS NULL
            WHERE review.analysis_status='completed' AND review.status<>'approved'
              AND (action.id IS NOT NULL OR (NULLIF(BTRIM(review.project_id),'') IS NULL AND NOT EXISTS(SELECT 1 FROM meeting_review_actions existing WHERE existing.artifact_id=review.artifact_id)))
            GROUP BY review.artifact_id,artifact.name`);
          for (const exception of exceptions.rows) {
            if (visibleIds.has(exception.id)) continue;
            items.push({ ...exception, resolution_only: true, projects: [], pmcs: [], roles: [], contact_id: null, contact_name: null,
              awaiting: false, analysis_status: 'completed',
              review_steps: [{ project: 'Sin obra vinculada', issue: 'Pendiente de vincular desde el panel lateral' }] });
          }
        }
        return void res.json({ enabled, ...projectMeetingList(items, req.query) });
      }
      artifactId = parts[0];
      if (!/^[0-9a-f-]{36}$/i.test(artifactId || '')) throw new WorkflowError(404, 'Reunión no encontrada.');
      client = await pool.connect();
      await client.query('BEGIN');
      const review = (await client.query(`SELECT review.* FROM meeting_reviews review LEFT JOIN meeting_project_drafts draft ON draft.artifact_id=review.artifact_id
        WHERE review.artifact_id=$1 AND (draft.artifact_id IS NOT NULL OR $2) ${req.method === 'GET' ? '' : 'FOR UPDATE OF review'}`, [artifactId, actor.admin && !actor.director && req.method === 'GET' && parts.length === 1])).rows[0];
      if (!review) throw new WorkflowError(404, 'Reunión no encontrada.');
      if (req.method !== 'GET' && !await projectMeetingsEnabled(client)) throw new WorkflowError(409, 'El nuevo flujo está pausado. Los borradores se conservan sin cambios.');
      const branches = (await client.query<Branch>('SELECT * FROM meeting_project_branches WHERE artifact_id=$1 ORDER BY project_id', [artifactId])).rows;
      const actions = (await client.query<Action>(`SELECT action.*,${actionResponsiblesSql} FROM meeting_review_actions action WHERE artifact_id=$1 ORDER BY created_at,id`, [artifactId])).rows;
      const visible = actions.filter((action) => visibleAction(action, branches.find((branch) => branch.project_id === (action.project_id || '')), branches, actor!));
      const ownBranches = branches.filter((branch) => !actor!.director && canSeeProjectBranch(branch, branches, actor!.employeeId));
      if (!visible.length && !ownBranches.length) {
        if (actor.admin && !actor.director && req.method === 'GET' && parts.length === 1 && review.status !== 'approved' && review.analysis_status === 'completed' && (actions.some((action) => !action.project_id?.trim()) || (!actions.length && !review.project_id))) {
          const name = (await client.query('SELECT name FROM google_drive_artifacts WHERE id=$1', [artifactId])).rows[0]?.name;
          await client.query('COMMIT');
          return void res.json({ id: artifactId, name, status: review.status, enabled, resolution_only: true,
            branches: [], actions: [], directory: [], history: [], add_projects: [] });
        }
        throw new WorkflowError(403, 'No tienes acceso a esta reunión.');
      }
      if (req.method === 'GET' && parts.length === 2 && parts[1] === 'recording') {
        if (actor.director || ownBranches.length !== branches.length) throw new WorkflowError(403, 'La grabación incluye otras obras fuera de tu ámbito.');
        await client.query('COMMIT');
        recordings?.schedule(artifactId);
        return void res.json(recordingState(review));
      }
      if (req.method === 'GET' && parts.length === 1) {
        const fullAccess = !actor.director && ownBranches.length === branches.length;
        const artifact = fullAccess ? (await client.query('SELECT name,content_text FROM google_drive_artifacts WHERE id=$1', [artifactId])).rows[0] : null;
        const directory = await client.query(`SELECT employee.id, CONCAT_WS(' ',employee.nombre,employee.apellido) AS name, COALESCE(direction.is_director,FALSE) AS is_director
          FROM empleados employee LEFT JOIN LATERAL (SELECT TRUE AS is_director FROM organigrama_cargo_asignaciones assignment JOIN organigrama_cargos cargo ON cargo.id=assignment.cargo_id AND cargo.activo=TRUE
            WHERE assignment.empleado_id=employee.id AND assignment.activo=TRUE AND (LOWER(cargo.codigo) IN ('director','director_general') OR LOWER(cargo.nombre) IN ('director','director general')) LIMIT 1) direction ON TRUE
          WHERE employee.activo=TRUE AND (employee.id=ANY($1::text[]) OR direction.is_director=TRUE)
          ORDER BY employee.nombre,employee.apellido,employee.id`, [[...new Set(branches.filter((branch) => ownBranches.includes(branch) || visible.some((action) => action.project_id === branch.project_id)).flatMap((branch) => branch.snapshot.team.map((person) => person.id)))]]);
        const risks = fullAccess ? (await client.query('SELECT * FROM meeting_review_blockers WHERE artifact_id=$1 ORDER BY created_at,id', [artifactId])).rows : [];
        const histories = await client.query(`SELECT operation,detail,created_at,actor_id FROM meeting_project_audit
          WHERE artifact_id=$1 AND project_id=ANY($2::text[]) ORDER BY id DESC LIMIT 100`, [artifactId, ownBranches.map((branch) => branch.project_id)]);
        await client.query('COMMIT');
        if (fullAccess) recordings?.schedule(artifactId);
        return void res.json({ id: artifactId, status: review.status, enabled, ...(fullAccess ? recordingState(review) : {}), recording_access: fullAccess, name: artifact?.name || `Reunión · ${ownBranches.map((branch) => branch.project_name).join(' / ') || 'Acciones de Dirección'}`,
          meeting_date: review.meeting_date, meeting_kind: review.meeting_kind, contact_name: fullAccess ? review.contact_name : null,
          relevant_information: fullAccess ? review.relevant_information : '', content_text: artifact?.content_text || '', detected_blockers: risks,
          summary: fullAccess ? review.summary : '', decisions: fullAccess ? review.decisions : '',
          partial_scope: !fullAccess, history: histories.rows, directory: directory.rows,
          add_projects: branches.filter((branch) => ownBranches.includes(branch) || (actor!.director && visible.some((action) => action.project_id === branch.project_id))).map((branch) => ({ id: branch.project_id, name: branch.project_name })),
          branches: ownBranches.map((branch) => ({ ...branch, can_review: enabled && review.status !== 'approved' && canReviewBranch(branch, branches, actor!.employeeId) })),
          actions: visible.map((action) => {
            const branch = branches.find((candidate) => candidate.project_id === (action.project_id || ''));
            const pmc = branch?.snapshot.pmcId === actor!.employeeId;
            return { ...action, can_delete: actor!.director || pmc, can_escalate: pmc, team: branch?.snapshot.team || [] };
          }) });
      }
      if (review.status === 'approved') throw new WorkflowError(409, 'El resultado aprobado es inmutable.');
      if (parts[1] === 'workflow' && req.method === 'POST') {
        const branch = branches.find((candidate) => candidate.id === req.body.branch_id);
        if (!branch || actor.director || !canReviewBranch(branch, branches, actor.employeeId)) throw new WorkflowError(403, 'Solo el revisor actual de la rama puede avanzar o devolver.');
        const command = req.body.command;
        if (!['approve','return'].includes(command) || req.body.recipient_id) throw new WorkflowError(400, 'La cadena no admite destinatarios libres.');
        if (command === 'return') {
          if (branch.cursor === 0 || !String(req.body.reason || '').trim()) throw new WorkflowError(409, 'Indica un motivo y un revisor anterior disponible.');
          await client.query('UPDATE meeting_project_branches SET cursor=cursor-1,approved=FALSE,updated_at=NOW() WHERE id=$1', [branch.id]);
          await client.query('UPDATE meeting_project_branches SET approved=FALSE WHERE artifact_id=$1', [artifactId]);
        } else {
          const blockers = actions.filter((action) => action.project_id === branch.project_id && (!action.responsible_id || !action.due_date));
          if (blockers.length) throw new WorkflowError(409, `Falta responsable o fecha en ${blockers.length} acciones. No se deducen fechas.`);
          const final = branch.snapshot.path[branch.cursor].final;
          await client.query('UPDATE meeting_project_branches SET cursor=cursor+$2,approved=$3,updated_at=NOW() WHERE id=$1', [branch.id, final ? 0 : 1, final]);
          await client.query(`UPDATE meeting_reviews SET status='approved',approved_at=NOW(),approved_by=$2,updated_at=NOW()
            WHERE artifact_id=$1 AND NOT EXISTS(SELECT 1 FROM meeting_project_branches WHERE artifact_id=$1 AND approved=FALSE)`, [artifactId, String(actor.userId)]);
        }
        await audit(client, artifactId, branch.project_id, String(actor.userId), command, { branchId: branch.id, from: branch.snapshot.path[branch.cursor], reason: req.body.reason || null });
      } else if (parts[1] === 'actions') {
        const existing = actions.find((action) => action.id === parts[2]);
        const branch = branches.find((candidate) => candidate.project_id === (existing?.project_id || String(req.body.project_id || '')));
        if (!branch || (existing ? !visible.some((action) => action.id === existing.id) : !ownBranches.some((candidate) => candidate.id === branch.id) && !actor.director)) throw new WorkflowError(403, 'La acción no está dentro de tu ámbito.');
        if (!existing && parts[2]) throw new WorkflowError(404, 'Acción no encontrada.');
        if (!existing && actor.director && !visible.some((action) => action.project_id === branch.project_id)) throw new WorkflowError(403, 'Sin acciones visibles de este proyecto.');
        const before = existing || null;
        const actionId = existing?.id || randomUUID();
        if (parts[3] === 'responsibles' && parts.length === 4 && existing && ['PUT','DELETE'].includes(req.method)) {
          if (req.body.kind !== 'employee' || !req.body.id) throw new WorkflowError(400, 'Selecciona un empleado del equipo.');
          const person = (await client.query("SELECT id,CONCAT_WS(' ',nombre,apellido) AS name FROM empleados WHERE id=$1 AND activo=TRUE", [req.body.id])).rows[0];
          if (req.method === 'PUT') {
            if (!person) throw new WorkflowError(400, 'El responsable debe estar activo.');
            const member = branch.snapshot.team.some((entry) => entry.id === person.id);
            if (!member) {
              const director = await client.query(`SELECT 1 FROM organigrama_cargo_asignaciones assignment JOIN organigrama_cargos cargo ON cargo.id=assignment.cargo_id AND cargo.activo=TRUE
                WHERE assignment.empleado_id=$1 AND assignment.activo=TRUE AND (LOWER(cargo.codigo) IN ('director','director_general') OR LOWER(cargo.nombre) IN ('director','director general')) LIMIT 1`, [person.id]);
              if (!director.rowCount) throw new WorkflowError(400, 'El responsable debe pertenecer al proyecto o ser Director.');
            }
            if (req.body.previous_id) {
              if (req.body.previous_kind !== 'employee') throw new WorkflowError(400, 'Tipo de responsable inválido.');
              await client.query("DELETE FROM meeting_review_action_responsibles WHERE action_id=$1 AND responsible_kind='employee' AND responsible_id=$2", [actionId, req.body.previous_id]);
            }
            await client.query(`INSERT INTO meeting_review_action_responsibles(action_id,responsible_kind,responsible_id,employee_id,responsible_name,responsible_role)
              VALUES($1,'employee',$2,$2,$3,$4) ON CONFLICT(action_id,responsible_kind,responsible_id) DO NOTHING`,
              [actionId, person.id, person.name, branch.snapshot.path.find((step) => step.employeeId === person.id)?.cargo || 'Empleado']);
          } else {
            await client.query("DELETE FROM meeting_review_action_responsibles WHERE action_id=$1 AND responsible_kind='employee' AND responsible_id=$2", [actionId, req.body.id]);
          }
          await client.query("UPDATE meeting_review_actions SET assignment_origin='manual',updated_at=NOW() WHERE id=$1", [actionId]);
        } else if (req.method === 'DELETE' && existing && parts.length === 3) {
          if (!actor.director && branch.snapshot.pmcId !== actor.employeeId) throw new WorkflowError(403, 'Solo PMC y Director pueden borrar acciones.');
          if (!String(req.body.reason || '').trim()) throw new WorkflowError(400, 'El borrado requiere motivo.');
          await client.query('DELETE FROM meeting_review_actions WHERE id=$1', [actionId]);
        } else if (req.method === 'PUT' && parts[3] === 'escalation' && existing) {
          if (branch.snapshot.pmcId !== actor.employeeId || actor.director) throw new WorkflowError(403, 'Solo el PMC del proyecto puede escalar a Dirección.');
          if (typeof req.body.escalated !== 'boolean') throw new WorkflowError(400, 'Indica si se escala a Dirección.');
          await client.query('UPDATE meeting_review_actions SET escalated_at=CASE WHEN $2 THEN NOW() END,escalated_by=CASE WHEN $2 THEN $3 END WHERE id=$1', [actionId, req.body.escalated, actor.employeeId]);
        } else if ((req.method === 'PUT' && existing && parts.length === 3) || (req.method === 'POST' && !existing && parts.length === 2)) {
          const title = String(req.body.title ?? existing?.title ?? '').trim();
          if (!title || title.length > 10000) throw new WorkflowError(400, 'Indica un título válido.');
          const dueDate = req.body.due_date === undefined ? existing?.due_date || null : req.body.due_date || null;
          const dueDateText = dueDate instanceof Date ? dueDate.toISOString().slice(0,10) : String(dueDate || '').slice(0,10);
          if (dueDateText && !/^\d{4}-\d{2}-\d{2}$/.test(dueDateText)) throw new WorkflowError(400, 'Fecha inválida.');
          const assigned = Object.hasOwn(req.body, 'responsible_id');
          const responsibleId = assigned ? req.body.responsible_id || null : existing ? existing.responsible_id : branch.snapshot.pmcId;
          const person = responsibleId ? (await client.query("SELECT id,CONCAT_WS(' ',nombre,apellido) AS name FROM empleados WHERE id=$1 AND activo=TRUE", [responsibleId])).rows[0] : null;
          if (responsibleId && !person) throw new WorkflowError(400, 'El responsable debe ser un empleado activo del equipo.');
          if (person && !branch.snapshot.team.some((member) => member.id === person.id)) {
            const director = await client.query(`SELECT 1 FROM organigrama_cargo_asignaciones assignment JOIN organigrama_cargos cargo ON cargo.id=assignment.cargo_id AND cargo.activo=TRUE
              WHERE assignment.empleado_id=$1 AND assignment.activo=TRUE AND (LOWER(cargo.codigo) IN ('director','director_general') OR LOWER(cargo.nombre) IN ('director','director general')) LIMIT 1`, [person.id]);
            if (!director.rowCount) throw new WorkflowError(400, 'El responsable debe estar vinculado al proyecto o ser Director.');
          }
          const name = person?.name || null;
          await client.query(`INSERT INTO meeting_review_actions(id,artifact_id,project_id,project_name,title,responsible_id,responsible,responsible_kind,responsible_source,assignment_origin,due_date,origin)
            VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $6::varchar IS NOT NULL THEN 'employee' END,CASE WHEN $9 THEN 'manual' ELSE 'automatic' END,CASE WHEN $9 THEN 'manual' WHEN $6::varchar IS NOT NULL THEN 'pmc_default' ELSE 'unassigned' END,$8,'manual')
            ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,due_date=EXCLUDED.due_date,
              responsible_id=CASE WHEN $9 THEN EXCLUDED.responsible_id ELSE meeting_review_actions.responsible_id END,
              responsible=CASE WHEN $9 THEN EXCLUDED.responsible ELSE meeting_review_actions.responsible END,
              responsible_kind=CASE WHEN $9 THEN EXCLUDED.responsible_kind ELSE meeting_review_actions.responsible_kind END,
              responsible_source=CASE WHEN $9 THEN 'manual' ELSE meeting_review_actions.responsible_source END,
              assignment_origin=CASE WHEN $9 THEN 'manual' ELSE meeting_review_actions.assignment_origin END,updated_at=NOW()`,
          [actionId, artifactId, branch.project_id, branch.project_name, title, responsibleId, name, dueDateText || null, assigned]);
          if (assigned && responsibleId) await client.query("DELETE FROM meeting_review_action_responsibles WHERE action_id=$1 AND responsible_kind='employee' AND responsible_id=$2", [actionId, responsibleId]);
        } else throw new WorkflowError(400, 'Operación no admitida.');
        const contentChanged = !existing || (req.method === 'DELETE' && parts.length === 3) || (Object.hasOwn(req.body,'title') && req.body.title !== existing.title) || (Object.hasOwn(req.body,'due_date') && String(req.body.due_date || '').slice(0,10) !== String(existing.due_date || '').slice(0,10));
        await client.query('UPDATE meeting_project_branches SET cursor=CASE WHEN $2 THEN 0 ELSE cursor END,approved=FALSE,updated_at=NOW() WHERE id=$1', [branch.id, contentChanged]);
        await client.query('UPDATE meeting_project_branches SET approved=FALSE WHERE artifact_id=$1', [artifactId]);
        await audit(client, artifactId, branch.project_id, String(actor.userId), req.method === 'DELETE' && parts.length === 3 ? 'action-deleted' : 'action-changed', { before, after: (await client.query(`SELECT action.*,${actionResponsiblesSql} FROM meeting_review_actions action WHERE id=$1`, [actionId])).rows[0] || null, reason: req.body.reason || null });
      } else throw new WorkflowError(404, 'Operación no disponible en el flujo por proyectos.');
      await client.query('UPDATE meeting_reviews SET updated_at=NOW() WHERE artifact_id=$1', [artifactId]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (error) {
      if (client) await client.query('ROLLBACK');
      if (error instanceof WorkflowError && error.status === 403) await audit(pool, /^[0-9a-f-]{36}$/i.test(artifactId || '') ? artifactId : null, null, String(actor?.userId || 'unknown'), 'denied', { method: req.method, path: req.path }).catch(() => undefined);
      if (!(error instanceof WorkflowError)) console.error('[project-meetings]', error);
      res.status(error instanceof WorkflowError ? error.status : 500).json({ error: error instanceof WorkflowError ? error.message : 'No se pudo completar la operación de reuniones.' });
    } finally { client?.release(); }
  });
  app.use('/api/meetings/work-items', async (req, res, next) => {
    try {
      if (!await projectMeetingsEnabled(pool) && !(await pool.query('SELECT 1 FROM meeting_project_drafts LIMIT 1')).rowCount) return next();
      const session = readSession(req);
      if (!session) return void res.status(401).json({ error: 'Inicia sesión.' });
      const actor = await actorFromSession(pool, session);
      if (!actor.employeeId) return void res.json({ items: [], total: 0, unread: 0, actions: 0, reviews: 0 });
      const branches = (await pool.query<Branch>('SELECT * FROM meeting_project_branches ORDER BY artifact_id,project_id')).rows;
      const actions = (await pool.query<Action>(`SELECT action.*,${actionResponsiblesSql} FROM meeting_review_actions action JOIN meeting_project_drafts draft ON draft.artifact_id=action.artifact_id
        WHERE action.status='pending' AND ((action.responsible_kind='employee' AND action.responsible_id=$1) OR EXISTS(SELECT 1 FROM meeting_review_action_responsibles person WHERE person.action_id=action.id AND person.responsible_kind='employee' AND person.responsible_id=$1) OR ($2 AND action.escalated_at IS NOT NULL))`, [actor.employeeId,actor.director])).rows;
      const items = actions.filter((action) => visibleAction(action, branches.find((branch) => branch.artifact_id === action.artifact_id && branch.project_id === (action.project_id || '')), branches.filter((branch) => branch.artifact_id === action.artifact_id), actor)).map((action) => ({
        key: `project-action:${action.id}:${action.updated_at}`, kind: 'action', artifactId: action.artifact_id, actionId: action.id,
        title: action.title, detail: action.escalated_at ? 'Escalada a Dirección' : 'Acción asignada a ti', meetingName: 'Reunión del proyecto', projectName: action.project_name, dueDate: action.due_date, updatedAt: action.updated_at,
      }));
      if (!actor.director && await projectMeetingsEnabled(pool)) for (const branch of branches) {
        if (!canReviewBranch(branch, branches.filter((sibling) => sibling.artifact_id === branch.artifact_id), actor.employeeId)) continue;
        items.push({ key:`project-review:${branch.id}:${branch.cursor}:${branch.updated_at}`,kind:'review',artifactId:branch.artifact_id,actionId:'',
          title:'Revisión requerida',detail:'La rama del proyecto está pendiente de tu revisión.',meetingName:'Reunión del proyecto',projectName:branch.project_name,dueDate:null,updatedAt:branch.updated_at });
      }
      if (req.method === 'POST' && req.path === '/read') {
        const validKeys = new Set(items.map((item) => item.key));
        const requested = Array.isArray(req.body.keys) ? req.body.keys.filter((key: unknown) => typeof key === 'string' && validKeys.has(key)) : [];
        for (const key of requested) await pool.query('INSERT INTO meeting_notification_reads(user_id,notification_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[actor.userId,key]);
        return void res.json({ ok: true });
      }
      if (req.method !== 'GET') return void res.status(405).json({ error: 'Método no permitido.' });
      const reads = new Set((await pool.query('SELECT notification_key FROM meeting_notification_reads WHERE user_id=$1',[actor.userId])).rows.map((row) => row.notification_key));
      const result = items.map((item) => ({ ...item, unread: !reads.has(item.key) }));
      res.json({ items: result, total: result.length, actions: result.filter((item) => item.kind === 'action').length, reviews: result.filter((item) => item.kind === 'review').length, unread: result.filter((item) => item.unread).length });
    } catch { res.status(403).json({ error: 'No se pudo validar el acceso a pendientes.' }); }
  });
  app.use(['/api/meetings', '/api/operations/escalations', '/api/operations/incidents', '/api/operations/history'], async (_req, res, next) => {
    try {
      if (_req.baseUrl === '/api/meetings' && _req.path === '/configuration') return next();
      if (_req.baseUrl === '/api/operations/history' && !_req.path.startsWith('/incident/')) return next();
      if (await projectMeetingsEnabled(pool) || (await pool.query('SELECT 1 FROM meeting_project_drafts LIMIT 1')).rowCount) return void res.status(409).json({ error: 'Utiliza el gestor por proyectos. La vía anterior está desactivada para evitar saltos de permisos.' });
      const artifactId = _req.path.split('/').filter(Boolean)[0];
      if (_req.method !== 'GET' && /^[0-9a-f-]{36}$/i.test(artifactId || '') && (await pool.query('SELECT 1 FROM meeting_project_drafts WHERE artifact_id=$1', [artifactId])).rowCount) {
        return void res.status(409).json({ error: 'Este borrador pertenece al flujo por proyectos. No se puede modificar por la vía anterior.' });
      }
      next();
    } catch { res.status(503).json({ error: 'No se pudo comprobar la política de reuniones.' }); }
  });
}
