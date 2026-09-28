import { randomUUID } from 'node:crypto';
import type { Express, RequestHandler, Response } from 'express';
import type { Pool, PoolClient } from 'pg';

export async function ensureDashboardOperations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dashboard_change_events (
      id UUID PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, before_data JSONB, after_data JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS dashboard_change_events_entity ON dashboard_change_events(entity_type, entity_id, created_at);
    CREATE TABLE IF NOT EXISTS crm_leads (
      id UUID PRIMARY KEY, name VARCHAR(255) NOT NULL, email VARCHAR(255), phone VARCHAR(80),
      status VARCHAR(30) NOT NULL CHECK (status IN ('new','contacted','qualified','won','lost')),
      client_id VARCHAR(255) REFERENCES clientes(id) ON DELETE SET NULL,
      notes TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS meeting_incident_resolutions (
      blocker_id UUID PRIMARY KEY REFERENCES meeting_review_blockers(id) ON DELETE CASCADE,
      resolved BOOLEAN NOT NULL DEFAULT FALSE, note TEXT NOT NULL,
      actor_name TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

type Dependencies = {
  pool: Pool;
  admin: RequestHandler;
  actor: (res: Response) => string;
  identity: (res: Response) => { id: string; role: string };
  audit: (client: PoolClient, identity: { id: string; role: string }, artifactId?: string) => Promise<void>;
  nextStage: (artifactId: string, currentStage: string) => Promise<{ stage: string; label: string } | null>;
  publish: (name: string, payload: Record<string, unknown>) => void;
};

export function registerDashboardOperations(app: Express, deps: Dependencies): void {
  const { pool, admin } = deps;
  const fail = (res: Response, error: unknown) => res.status((error as { code?: string }).code?.startsWith('22') ? 400 : 500).json({ error: 'No se pudo completar la operación. Revisa los datos e inténtalo de nuevo.' });
  const record = async (client: PoolClient, res: Response, entity: string, id: string, before: unknown, after: unknown) => {
    await client.query('INSERT INTO dashboard_change_events (id, entity_type, entity_id, actor_id, actor_name, before_data, after_data) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), entity, id, deps.identity(res).id, deps.actor(res), JSON.stringify(before), JSON.stringify(after)]);
  };

  app.get('/api/directory/organization', admin, async (_req, res) => {
    try {
      const [positions, assignments] = await Promise.all([
        pool.query('SELECT id, nombre, cargo_padre_id, departamento, activo FROM organigrama_cargos ORDER BY departamento, nombre'),
        pool.query(`SELECT oca.id, oca.cargo_id, oca.empleado_id, oca.proyecto_id, oca.activo,
          CONCAT_WS(' ', e.nombre, e.apellido) AS employee_name, c.nombre AS position_name,
          p.nombre AS project_name, e.activo AS employee_active, oca.id LIKE 'local:%' AS editable
          FROM organigrama_cargo_asignaciones oca JOIN organigrama_cargos c ON c.id=oca.cargo_id
          JOIN empleados e ON e.id=oca.empleado_id LEFT JOIN proyectos p ON p.id=oca.proyecto_id
          ORDER BY p.nombre NULLS FIRST, c.nombre, e.nombre`),
      ]);
      res.json({ positions: positions.rows, assignments: assignments.rows });
    } catch (error) { fail(res, error); }
  });

  app.post('/api/directory/organization/assignments', admin, async (req, res) => {
    const { cargo_id, empleado_id, proyecto_id } = req.body || {};
    if (!cargo_id || !empleado_id) return res.status(400).json({ error: 'Selecciona cargo y empleado.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dashboard-org-assignments'))");
      const existing = await client.query('SELECT id FROM organigrama_cargo_asignaciones WHERE cargo_id=$1 AND empleado_id=$2 AND proyecto_id IS NOT DISTINCT FROM $3::varchar AND activo=TRUE', [cargo_id, empleado_id, proyecto_id || null]);
      if (existing.rows.length) return res.status(409).json({ error: 'La asignación ya existe.' });
      const created = await client.query(`INSERT INTO organigrama_cargo_asignaciones (id,cargo_id,empleado_id,proyecto_id)
        SELECT $1,c.id,e.id,$4 FROM organigrama_cargos c CROSS JOIN empleados e
        WHERE c.id=$2 AND c.activo=TRUE AND e.id=$3 AND e.activo=TRUE
        AND ($4::varchar IS NULL OR EXISTS(SELECT 1 FROM proyectos WHERE id=$4 AND activo=TRUE)) RETURNING *`, [`local:${randomUUID()}`, cargo_id, empleado_id, proyecto_id || null]);
      if (!created.rows.length) return res.status(400).json({ error: 'Cargo, persona y proyecto deben estar activos.' });
      await record(client, res, 'organization', created.rows[0].id, null, created.rows[0]);
      await client.query('COMMIT');
      deps.publish('meetings-updated', { source: 'organization-assignment' });
      res.status(201).json(created.rows[0]);
    } catch (error) { fail(res, error); } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  });

  app.delete('/api/directory/organization/assignments/:id', admin, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const deleted = await client.query("DELETE FROM organigrama_cargo_asignaciones WHERE id=$1 AND id LIKE 'local:%' RETURNING *", [req.params.id]);
      if (!deleted.rows.length) return res.status(409).json({ error: 'Solo se pueden retirar asignaciones locales; el origen Supabase es de solo lectura.' });
      await record(client, res, 'organization', String(req.params.id), deleted.rows[0], null);
      await client.query('COMMIT');
      deps.publish('meetings-updated', { source: 'organization-assignment' });
      res.json({ ok: true });
    } catch (error) { fail(res, error); } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  });

  app.get('/api/operations/escalations', admin, async (_req, res) => {
    try {
      const result = await pool.query(`SELECT r.artifact_id AS id, a.name, r.workflow_stage, r.updated_at, p.nombre AS project_name,
        FLOOR(EXTRACT(EPOCH FROM (NOW()-r.updated_at))/3600)::int AS waiting_hours
        FROM meeting_reviews r JOIN google_drive_artifacts a ON a.id=r.artifact_id LEFT JOIN proyectos p ON p.id=r.project_id
        WHERE r.status='pending' AND r.analysis_status='completed' ORDER BY r.updated_at`);
      res.json(result.rows);
    } catch (error) { fail(res, error); }
  });

  app.post('/api/operations/escalations/:id', admin, async (req, res) => {
    const reason = String(req.body?.reason || '').trim().slice(0,2000);
    if (reason.length < 5) return res.status(400).json({ error: 'Indica el motivo del escalado (mínimo 5 caracteres).' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = String(req.params.id);
      await deps.audit(client, deps.identity(res), id);
      const current = await client.query("SELECT workflow_stage FROM meeting_reviews WHERE artifact_id=$1 AND status='pending' AND analysis_status='completed'", [id]);
      if (!current.rows.length) return res.status(409).json({ error: 'La reunión ya no está pendiente de revisión.' });
      const previous = current.rows[0].workflow_stage;
      const next = await deps.nextStage(id, previous);
      if (!next) return res.status(409).json({ error: 'No hay un siguiente escalón con una persona activa. Revisa el organigrama.' });
      await client.query("SELECT set_config('lyn.audit_previous_stage',$1,TRUE),set_config('lyn.audit_event_type','escalate',TRUE)", [previous]);
      await client.query('UPDATE meeting_reviews SET workflow_stage=$2, manual_revision=TRUE, updated_at=NOW() WHERE artifact_id=$1', [id,next.stage]);
      await client.query('INSERT INTO meeting_review_versions(id,artifact_id,actor,stage,detail) VALUES($1,$2,$3,$4,$5)', [randomUUID(),id,deps.actor(res),next.stage,`Escalado a ${next.label} sin aprobar. Motivo: ${reason}`]);
      await client.query('COMMIT');
      deps.publish('meetings-updated',{source:'escalation',artifactId:id});
      res.json({ ok:true, stage:next.stage });
    } catch (error) { fail(res,error); } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  });

  app.get('/api/operations/incidents', admin, async (_req,res) => {
    try {
      const result = await pool.query(`SELECT b.*, a.name AS meeting_name, p.nombre AS project_name, COALESCE(s.resolved,FALSE) AS resolved, s.note, s.actor_name
        FROM meeting_review_blockers b JOIN meeting_reviews r ON r.artifact_id=b.artifact_id JOIN google_drive_artifacts a ON a.id=b.artifact_id
        LEFT JOIN proyectos p ON p.id=r.project_id LEFT JOIN meeting_incident_resolutions s ON s.blocker_id=b.id ORDER BY b.created_at DESC`);
      res.json(result.rows);
    } catch (error) { fail(res,error); }
  });

  app.put('/api/operations/incidents/:id', admin, async (req,res) => {
    const note=String(req.body?.note || '').trim().slice(0,2000);
    if(typeof req.body?.resolved !== 'boolean' || note.length < 5) return res.status(400).json({error:'Indica el estado y un motivo de al menos 5 caracteres.'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const blocker=await client.query('SELECT artifact_id FROM meeting_review_blockers WHERE id=$1',[req.params.id]);
      if(!blocker.rows.length) return res.status(404).json({error:'Incidencia no encontrada.'});
      await deps.audit(client,deps.identity(res),blocker.rows[0].artifact_id);
      if(!(await client.query('SELECT id FROM meeting_review_blockers WHERE id=$1 FOR UPDATE',[req.params.id])).rows.length) return res.status(409).json({error:'La incidencia cambió. Actualiza la lista.'});
      const previous=await client.query('SELECT * FROM meeting_incident_resolutions WHERE blocker_id=$1',[req.params.id]);
      const result=await client.query(`INSERT INTO meeting_incident_resolutions(blocker_id,resolved,note,actor_name) VALUES($1,$2,$3,$4)
        ON CONFLICT(blocker_id) DO UPDATE SET resolved=EXCLUDED.resolved,note=EXCLUDED.note,actor_name=EXCLUDED.actor_name,updated_at=NOW() RETURNING *`,[req.params.id,req.body.resolved,note,deps.actor(res)]);
      await client.query("INSERT INTO meeting_review_versions(id,artifact_id,actor,stage,detail) VALUES($1,$2,$3,'edición',$4)",[randomUUID(),blocker.rows[0].artifact_id,deps.actor(res),`${req.body.resolved ? 'Incidencia resuelta' : 'Incidencia reabierta'}: ${note}`]);
      await client.query('UPDATE meeting_reviews SET manual_revision=TRUE,updated_at=NOW() WHERE artifact_id=$1',[blocker.rows[0].artifact_id]);
      await record(client,res,'incident',String(req.params.id),previous.rows[0] || null,result.rows[0]);
      await client.query('COMMIT');
      deps.publish('meetings-updated',{source:'incident',artifactId:blocker.rows[0].artifact_id});
      res.json(result.rows[0]);
    } catch(error){ fail(res,error); } finally { await client.query('ROLLBACK').catch(() => undefined);client.release(); }
  });

  app.get('/api/crm/leads',admin,async(_req,res)=>{
    try { res.json((await pool.query('SELECT l.*,CONCAT_WS(\' \',c.nombre,c.apellido) AS client_name FROM crm_leads l LEFT JOIN clientes c ON c.id=l.client_id ORDER BY l.updated_at DESC')).rows); }
    catch(error){fail(res,error);}
  });
  app.put('/api/crm/leads/:id',admin,async(req,res)=>{
    const body=req.body || {};
    const name=String(body.name || '').trim().slice(0,255);
    const email=String(body.email || '').trim().toLowerCase().slice(0,255);
    if(!name || !['new','contacted','qualified','won','lost'].includes(body.status) || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return res.status(400).json({error:'Completa nombre, estado y un correo válido.'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const id=String(req.params.id);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`lead:${id}`]);
      if(body.client_id && !(await client.query('SELECT id FROM clientes WHERE id=$1 AND activo=TRUE',[body.client_id])).rows.length) return res.status(400).json({error:'Selecciona un cliente activo.'});
      const previous=await client.query('SELECT * FROM crm_leads WHERE id=$1 FOR UPDATE',[id]);
      const result=await client.query(`INSERT INTO crm_leads(id,name,email,phone,status,client_id,notes) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,phone=EXCLUDED.phone,status=EXCLUDED.status,client_id=EXCLUDED.client_id,notes=EXCLUDED.notes,updated_at=NOW() RETURNING *`,[id,name,email || null,String(body.phone || '').trim().slice(0,80),body.status,body.client_id || null,String(body.notes || '').slice(0,5000)]);
      await record(client,res,'lead',id,previous.rows[0] || null,result.rows[0]);
      await client.query('COMMIT');res.json(result.rows[0]);
    } catch(error){fail(res,error);}finally{await client.query('ROLLBACK').catch(()=>undefined);client.release();}
  });
  app.get('/api/crm/identities',admin,async(_req,res)=>{
    try {res.json((await pool.query(`SELECT ma.id,ma.artifact_id,ma.title,ma.responsible AS mentioned_name,ma.project_name,a.name AS meeting_name
      FROM meeting_review_actions ma JOIN google_drive_artifacts a ON a.id=ma.artifact_id
      WHERE ma.status='pending' AND ma.responsible_id IS NULL AND NOT EXISTS(SELECT 1 FROM meeting_review_action_responsibles extra WHERE extra.action_id=ma.id)
      ORDER BY ma.updated_at DESC`)).rows);}catch(error){fail(res,error);}
  });
  app.get('/api/operations/history/:entity/:id',admin,async(req,res)=>{
    try {res.json((await pool.query('SELECT actor_name,before_data,after_data,created_at FROM dashboard_change_events WHERE entity_type=$1 AND entity_id=$2 ORDER BY created_at DESC',[req.params.entity,req.params.id])).rows);}catch(error){fail(res,error);}
  });
}
