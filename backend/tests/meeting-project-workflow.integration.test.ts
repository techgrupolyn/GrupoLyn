import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerProjectMeetingRoutes, refreshProjectMeetings } from '../meeting-project-workflow.ts';
import { buildProjectSnapshot } from '../meeting-project-policy.ts';

const databaseUrl = process.env.QA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('Flujo de reuniones por proyectos en PostgreSQL local', () => {
  let server: typeof import('../server.ts');
  const app = express();
  app.use(express.json());
  const prefix = `branch-${randomUUID()}`;
  const connection = randomUUID();
  const folder = randomUUID();
  const meeting = randomUUID();
  const actions = [randomUUID(), randomUUID()];
  const projects = [`${prefix}-a`, `${prefix}-b`];
  const employees = ['first','second','pmc','director','outsider','replacement'].map((name) => `${prefix}-${name}`);
  const positions = ['low','pmc','director'].map((name) => `${prefix}-${name}`);
  const users = new Map<string, number>();
  const extraMeetings: string[] = [];
  const auth = (employee: number) => String(users.get(employees[employee]));
  const endpoint = `/api/project-meetings/${meeting}`;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/lyn_qa_retest') throw new Error('Solo base local QA');
    process.env.DATABASE_URL = databaseUrl;
    process.env.CEO_SESSION_SECRET = 'project-workflow-test-only';
    process.env.SUPABASE_SYNC_ENABLED = 'false';
    process.env.EVOLUTION_BACKGROUND_SYNC_ENABLED = 'false';
    process.env.MEETING_AI_BACKGROUND_ANALYSIS_ENABLED = 'false';
    server = await import('../server.ts');
    await server.pool.query(await readFile(new URL('../../schema.sql', import.meta.url), 'utf8'));
    await server.ensureDatabaseSchema();
    registerProjectMeetingRoutes(app, server.pool, (req) => ({ id: Number(req.header('x-test-user')), rol: req.header('x-test-admin') === 'true' ? 'superadmin' : 'employee:member' }));
    await server.pool.query('UPDATE meeting_project_feature SET enabled=TRUE');
    for (const employee of employees) {
      await server.pool.query('INSERT INTO empleados(id,nombre,numero,email) VALUES($1,$1,$1,$2)', [employee, `${employee}@example.test`]);
      const result = await server.pool.query("INSERT INTO usuarios(usuario,email,auth_provider,rol) VALUES($1,$2,'supabase','employee:member') RETURNING id", [employee, `${employee}@example.test`]);
      users.set(employee, result.rows[0].id);
    }
    for (const project of projects) await server.pool.query('INSERT INTO proyectos(id,nombre) VALUES($1,$1)', [project]);
    await server.pool.query("INSERT INTO organigrama_cargos(id,nombre,codigo,cargo_padre_id,es_direccion) VALUES($1,'Delineante','drafter',$2,FALSE),($2,'PMC','pmc',$3,FALSE),($3,'Director','director',NULL,TRUE)", positions);
    for (const [index, project] of projects.entries()) {
      await server.pool.query('INSERT INTO organigrama_cargo_asignaciones(id,cargo_id,empleado_id,proyecto_id) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [`${project}-low`, positions[0], employees[index], project, `${project}-pmc`, positions[1], employees[2]]);
    }
    await server.pool.query('INSERT INTO organigrama_cargo_asignaciones(id,cargo_id,empleado_id) VALUES($1,$2,$3)', [`${prefix}-director`, positions[2], employees[3]]);
    await server.pool.query("INSERT INTO google_drive_connections(id,google_email,access_token_encrypted,refresh_token_encrypted,created_by) VALUES($1,'qa@example.test','unused','unused','qa')", [connection]);
    await server.pool.query("INSERT INTO google_drive_folders(id,connection_id,google_folder_id,label,created_by) VALUES($1::uuid,$2,$1::text,'QA ramas','qa')", [folder,connection]);
    await server.pool.query("INSERT INTO google_drive_artifacts(id,connection_id,folder_id,google_file_id,name,mime_type,artifact_type,content_text) VALUES($1::uuid,$2,$3,$1::text,'Comité QA','text/plain','transcript','Contenido de dos obras')", [meeting,connection,folder]);
    await server.pool.query("INSERT INTO meeting_reviews(artifact_id,analysis_status,summary,meeting_kind) VALUES($1,'completed','Resumen privado de ambas obras','COMITE_OBRA')", [meeting]);
    for (const [index, action] of actions.entries()) await server.pool.query("INSERT INTO meeting_review_actions(id,artifact_id,project_id,project_name,title,source_ref,origin) VALUES($1,$2,$3,$3,$4,'Fragmento de prueba','ai')", [action,meeting,projects[index], `Acción ${index}`]);
    await refreshProjectMeetings(server.pool);
  }, 60000);

  afterAll(async () => {
    if (!server) return;
    await server.pool.query('UPDATE meeting_project_feature SET enabled=FALSE');
    await server.pool.query('DELETE FROM google_drive_connections WHERE id=$1', [connection]);
    await server.pool.query('DELETE FROM organigrama_cargos WHERE id=ANY($1::text[])', [positions]);
    await server.pool.query('DELETE FROM usuarios WHERE id=ANY($1::int[])', [[...users.values()]]);
    await server.pool.query('DELETE FROM empleados WHERE id=ANY($1::text[])', [employees]);
    await server.pool.query('DELETE FROM proyectos WHERE id=ANY($1::text[])', [projects]);
    await server.pool.query('DELETE FROM meeting_project_audit WHERE artifact_id=ANY($1::uuid[])', [[meeting,...extraMeetings]]);
    await server.pool.end();
  });

  it('aísla obras, oculta el resumen conjunto y no entrega borradores al PMC ni Director', async () => {
    const payload = Buffer.from(JSON.stringify({ id:users.get(employees[0]),rol:'employee:delineante',exp:Date.now()+60000 })).toString('base64url');
    const token = `${payload}.${createHmac('sha256','project-workflow-test-only').update(payload).digest('base64url')}`;
    expect((await request(server.app).get(endpoint).set('Authorization',`Bearer ${token}`)).status).toBe(200);
    expect((await request(server.app).get(endpoint)).status).toBe(401);
    const first = await request(app).get(endpoint).set('x-test-user', auth(0));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.actions.map((action: { id: string }) => action.id)).toEqual([actions[0]]);
    expect(first.body.summary).toBe('');
    expect(first.body.actions[0]).toMatchObject({ responsible_id: employees[2], assignment_origin: 'pmc_default', can_delete: false });
    for (const employee of [2,3,4]) expect((await request(app).get(endpoint).set('x-test-user', auth(employee))).status).toBe(403);
    expect((await request(app).get(endpoint).set('x-test-user', auth(4)).set('x-test-admin','true')).status).toBe(403);
  });
  it('solo entrega la grabación a quien ve todas las obras de la reunión', async () => {
    const original = (await server.pool.query('SELECT id,snapshot FROM meeting_project_branches WHERE artifact_id=$1 AND project_id=$2', [meeting,projects[1]])).rows[0];
    try {
      await server.pool.query("UPDATE meeting_reviews SET recording_file_id='video123456',recording_status='available' WHERE artifact_id=$1", [meeting]);
      const partial = await request(app).get(endpoint).set('x-test-user',auth(0));
      expect(partial.body.recording_access).toBe(false);
      expect(partial.body.recording_file_id).toBeUndefined();
      for (const employee of [0,3,4]) expect((await request(app).get(`${endpoint}/recording`).set('x-test-user',auth(employee))).status).toBe(403);
      expect((await request(server.app).get(`${endpoint}/recording`)).status).toBe(401);
      const snapshot = { ...original.snapshot, team: [...original.snapshot.team,{ id: employees[0], name: 'Miembro de ambas obras', cargoIds: [positions[0]] }] };
      await server.pool.query('UPDATE meeting_project_branches SET snapshot=$2::jsonb WHERE id=$1',[original.id,JSON.stringify(snapshot)]);
      const full = await request(app).get(`${endpoint}/recording`).set('x-test-user',auth(0));
      expect(full.status).toBe(200);
      expect(full.body).toEqual({recording_status:'available',recording_file_id:'video123456'});
      const detail = await request(app).get(endpoint).set('x-test-user',auth(0));
      expect(detail.body).toMatchObject({recording_access:true,recording_file_id:'video123456',recording_status:'available'});
    } finally {
      await server.pool.query('UPDATE meeting_project_branches SET snapshot=$2::jsonb WHERE id=$1',[original.id,JSON.stringify(original.snapshot)]);
      await server.pool.query("UPDATE meeting_reviews SET recording_file_id=NULL,recording_status='pending' WHERE artifact_id=$1",[meeting]);
    }
  });
  it('un PMC de una obra actúa como delineante en otra sin heredar permisos de borrado ni escalado', async () => {
    try {
      await server.pool.query('UPDATE organigrama_cargo_asignaciones SET empleado_id=$2 WHERE id=$1',[`${projects[1]}-low`,employees[2]]);
      await server.pool.query('UPDATE organigrama_cargo_asignaciones SET empleado_id=$2 WHERE id=$1',[`${projects[1]}-pmc`,employees[0]]);
      await refreshProjectMeetings(server.pool);
      const response = await request(app).get(endpoint).set('x-test-user',auth(2));
      expect(response.status).toBe(200);
      expect(response.body.actions.map((action: { id: string })=>action.id)).toEqual([actions[1]]);
      expect(response.body.actions[0]).toMatchObject({can_delete:false,can_escalate:false});
      expect(response.body.branches).toHaveLength(1);
      expect(response.body.branches[0]).toMatchObject({project_id:projects[1],can_review:true,snapshot:{pmcId:employees[0]}});
      expect(response.body.branches[0].snapshot.path.map((step: { employeeId: string })=>step.employeeId)).toEqual([employees[2],employees[0]]);
      expect((await request(app).delete(`${endpoint}/actions/${actions[1]}`).set('x-test-user',auth(2)).send({reason:'Cargo de otra obra'})).status).toBe(403);
      expect((await server.pool.query('SELECT 1 FROM meeting_review_actions WHERE id=$1',[actions[1]])).rowCount).toBe(1);
    } finally {
      await server.pool.query('UPDATE organigrama_cargo_asignaciones SET empleado_id=$2 WHERE id=$1',[`${projects[1]}-low`,employees[1]]);
      await server.pool.query('UPDATE organigrama_cargo_asignaciones SET empleado_id=$2 WHERE id=$1',[`${projects[1]}-pmc`,employees[2]]);
      await refreshProjectMeetings(server.pool);
    }
  });
  it('sirve listado, filtros y métricas sin revelar obras ajenas ni el título conjunto', async () => {
    const response = await request(app).get('/api/project-meetings?pageSize=1').set('x-test-user', auth(0));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ page: 1, pageSize: 1, total: 1, metrics: { pending: 1, awaiting: 1 } });
    expect(response.body.options.projects).toEqual([{ id: projects[0], nombre: projects[0] }]);
    expect(response.body.items[0].name).not.toBe('Comité QA');
    expect(JSON.stringify(response.body)).not.toContain(projects[1]);
    expect((await request(app).get('/api/project-meetings').query({ projectId: projects[1] }).set('x-test-user', auth(0))).body.total).toBe(0);
    expect((await request(app).get('/api/project-meetings?filter=mine').set('x-test-user', auth(2))).body.total).toBe(0);
  });
  it('el diagnóstico de solo lectura reproduce las ramas y permite activar datos válidos', async () => {
    const script = (await readFile(new URL('../../deploy/scripts/check-meeting-project-readiness.sql', import.meta.url), 'utf8')).replace(/^\\set.*\r?\n/, '');
    const responses = await server.pool.query(script) as unknown as { rows: { jsonb_build_object?: { positions: Parameters<typeof buildProjectSnapshot>[1]; projects: { id: string; team: Parameters<typeof buildProjectSnapshot>[0] }[] } }[] }[];
    const data = responses.flatMap((response) => response.rows).find((row) => row.jsonb_build_object)?.jsonb_build_object;
    expect(data).toBeTruthy();
    for (const projectId of projects) {
      const project = data!.projects.find((project) => project.id === projectId)!;
      const saved = (await server.pool.query('SELECT snapshot FROM meeting_project_branches WHERE artifact_id=$1 AND project_id=$2', [meeting,projectId])).rows[0].snapshot;
      expect(buildProjectSnapshot(project.team, data!.positions)).toEqual(saved);
    }
    await server.pool.query('UPDATE meeting_project_feature SET enabled=FALSE');
    await server.pool.query("UPDATE usuarios SET rol='superadmin' WHERE id=$1", [users.get(employees[4])]);
    try {
      const activated = await request(app).put('/api/project-meetings/mode').set('x-test-user',auth(4)).send({ enabled:true });
      expect(activated.status,JSON.stringify(activated.body)).toBe(200);
      expect(activated.body.enabled).toBe(true);
    } finally {
      await server.pool.query("UPDATE usuarios SET rol='employee:member' WHERE id=$1", [users.get(employees[4])]);
      await server.pool.query('UPDATE meeting_project_feature SET enabled=TRUE');
    }
  });
  it('pausa y reanuda por API sin perder contenido, firmas o responsables ni abrir la vía antigua', async () => {
    const readState = async () => ({
      actions: (await server.pool.query('SELECT * FROM meeting_review_actions WHERE artifact_id=$1 ORDER BY id', [meeting])).rows,
      branches: (await server.pool.query('SELECT * FROM meeting_project_branches WHERE artifact_id=$1 ORDER BY id', [meeting])).rows,
    });
    const before = await readState();
    await server.pool.query("UPDATE usuarios SET rol='superadmin' WHERE id=$1", [users.get(employees[4])]);
    try {
      expect((await request(app).put('/api/project-meetings/mode').set('x-test-user',auth(0)).send({ enabled:false })).status).toBe(403);
      expect((await request(app).put('/api/project-meetings/mode').set('x-test-user',auth(4)).send({ enabled:false })).status).toBe(200);
      expect((await request(app).get(endpoint).set('x-test-user',auth(0))).status).toBe(200);
      expect((await request(app).put(`${endpoint}/actions/${actions[0]}`).set('x-test-user',auth(0)).send({ title:'No guardar durante pausa' })).status).toBe(409);
      expect((await request(app).post(`${endpoint}/workflow`).set('x-test-user',auth(0)).send({ branch_id:before.branches[0].id,command:'approve' })).status).toBe(409);
      expect((await request(app).put(`/api/meetings/${meeting}/actions/${actions[0]}`).set('x-test-user',auth(0)).send({ title:'No saltar permisos' })).status).toBe(409);
      expect(await readState()).toEqual(before);
      expect((await request(app).put('/api/project-meetings/mode').set('x-test-user',auth(4)).send({ enabled:true })).status).toBe(200);
      expect(await readState()).toEqual(before);
    } finally {
      await server.pool.query("UPDATE usuarios SET rol='employee:member' WHERE id=$1", [users.get(employees[4])]);
      await server.pool.query('UPDATE meeting_project_feature SET enabled=TRUE');
    }
  });

  it('revierte el interruptor si falla la auditoría, sin dejar una activación parcial', async () => {
    await server.pool.query("UPDATE usuarios SET rol='superadmin' WHERE id=$1", [users.get(employees[4])]);
    await server.pool.query(`CREATE FUNCTION qa_fail_meeting_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.operation='feature-changed' THEN RAISE EXCEPTION 'Fallo controlado de auditoría'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_fail_meeting_activation BEFORE INSERT ON meeting_project_audit FOR EACH ROW EXECUTE FUNCTION qa_fail_meeting_activation()`);
    try {
      const result = await request(app).put('/api/project-meetings/mode').set('x-test-user',auth(4)).send({enabled:false});
      expect(result.status).toBe(500);
      expect((await server.pool.query('SELECT enabled FROM meeting_project_feature')).rows[0].enabled).toBe(true);
    } finally {
      await server.pool.query('DROP TRIGGER qa_fail_meeting_activation ON meeting_project_audit; DROP FUNCTION qa_fail_meeting_activation()');
      await server.pool.query("UPDATE usuarios SET rol='employee:member' WHERE id=$1", [users.get(employees[4])]);
    }
  });
  it('bloquea borrar para delineante/superadmin, registra el rechazo y no expone otra obra', async () => {
    for (const suffix of ['', 'admin']) {
      expect((await request(app).delete(`${endpoint}/actions/${actions[0]}`).set('x-test-user',auth(0)).set('x-test-admin',suffix ? 'true' : 'false').send({ reason:'No permitido' })).status).toBe(403);
    }
    expect((await server.pool.query("SELECT 1 FROM meeting_project_audit WHERE artifact_id=$1 AND operation='denied'", [meeting])).rowCount).toBeGreaterThan(0);
    expect((await request(app).put(`${endpoint}/actions/${actions[1]}`).set('x-test-user',auth(0)).send({ title:'No autorizado' })).status).toBe(403);
  });
  it('exige fecha y responsable, permite editar/asignar y no cambia el camino con el responsable', async () => {
    const detail = (await request(app).get(endpoint).set('x-test-user',auth(0))).body;
    expect((await request(app).post(`${endpoint}/workflow`).set('x-test-user',auth(0)).send({ branch_id:detail.branches[0].id,command:'approve' })).status).toBe(409);
    const update = await request(app).put(`${endpoint}/actions/${actions[0]}`).set('x-test-user',auth(0)).send({ title:'Acción revisada',responsible_id:employees[3],due_date:'2026-11-01' });
    expect(update.status,JSON.stringify(update.body)).toBe(200);
    const after = (await request(app).get(endpoint).set('x-test-user',auth(0))).body;
    expect(after.branches[0].snapshot.path).toEqual(detail.branches[0].snapshot.path);
    expect((await request(app).get(endpoint).set('x-test-user',auth(3))).body.actions.map((action: { id: string }) => action.id)).toEqual([actions[0]]);
    expect((await request(app).post(`${endpoint}/workflow`).set('x-test-user',auth(0)).send({ branch_id:detail.branches[0].id,command:'approve',recipient_id:employees[3] })).status).toBe(400);
  });
  it('la sincronización no reinicia ramas sin cambios; reasigna pendientes al nuevo PMC y conserva manuales', async () => {
    const before = (await server.pool.query('SELECT * FROM meeting_project_branches WHERE artifact_id=$1 ORDER BY project_id',[meeting])).rows;
    await refreshProjectMeetings(server.pool);
    expect((await server.pool.query('SELECT * FROM meeting_project_branches WHERE artifact_id=$1 ORDER BY project_id',[meeting])).rows).toEqual(before);
    await server.pool.query('UPDATE organigrama_cargo_asignaciones SET empleado_id=$2 WHERE proyecto_id=ANY($1::text[]) AND cargo_id=$3',[projects,employees[5],positions[1]]);
    await refreshProjectMeetings(server.pool);
    const after = (await server.pool.query('SELECT id,responsible_id,assignment_origin FROM meeting_review_actions WHERE artifact_id=$1 ORDER BY title',[meeting])).rows;
    expect(after).toEqual(expect.arrayContaining([
      expect.objectContaining({ id:actions[0],responsible_id:employees[3],assignment_origin:'manual' }),
      expect.objectContaining({ id:actions[1],responsible_id:employees[5],assignment_origin:'pmc_default' }),
    ]));
    const branch = (await server.pool.query('SELECT * FROM meeting_project_branches WHERE artifact_id=$1 LIMIT 1',[meeting])).rows[0];
    expect(branch.initial_snapshot.pmcId).toBe(employees[2]);
    expect(branch.snapshot.pmcId).toBe(employees[5]);
  });
  it('reconoce el cargo real PMC / Proyectos sin convertir roles de acceso en cargos', async () => {
    await server.pool.query("UPDATE organigrama_cargos SET nombre='PMC / Proyectos',codigo=$2 WHERE id=$1", [positions[1], randomUUID()]);
    await server.pool.query("INSERT INTO organigrama_cargo_roles(cargo_id,rol) VALUES($1,'interiorista'),($2,'interiorista')", [positions[0],positions[1]]);
    await server.pool.query("INSERT INTO proyecto_asignaciones(id,proyecto_id,empleado_id,rol_en_proyecto) VALUES($1,$2,$3,'interiorista')", [`${prefix}-membership`,projects[0],employees[0]]);
    try {
      await refreshProjectMeetings(server.pool);
      const snapshot = (await server.pool.query('SELECT snapshot FROM meeting_project_branches WHERE artifact_id=$1 AND project_id=$2', [meeting,projects[0]])).rows[0].snapshot;
      expect(snapshot.issue).toBeNull();
      expect(snapshot.pmcId).toBe(employees[5]);
      expect(snapshot.path.map((step: { employeeId: string }) => step.employeeId)).toEqual([employees[0],employees[5]]);
      expect(snapshot.team.find((person: { id: string }) => person.id === employees[0]).cargoIds).toEqual([positions[0]]);
    } finally {
      await server.pool.query('DELETE FROM proyecto_asignaciones WHERE id=$1', [`${prefix}-membership`]);
      await server.pool.query('DELETE FROM organigrama_cargo_roles WHERE cargo_id=ANY($1::text[])', [[positions[0],positions[1]]]);
      await server.pool.query("UPDATE organigrama_cargos SET nombre='PMC',codigo='pmc' WHERE id=$1", [positions[1]]);
      await refreshProjectMeetings(server.pool);
    }
  });
  it('permite designar revisores solo en CEO, valida el vínculo y conserva el equipo de Club', async () => {
    const duplicateIds = [`${prefix}-duplicate-low`,`${prefix}-duplicate-pmc`];
    await server.pool.query('INSERT INTO organigrama_cargo_asignaciones(id,cargo_id,empleado_id,proyecto_id) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [duplicateIds[0],positions[0],employees[1],projects[0],duplicateIds[1],positions[1],employees[2]]);
    await refreshProjectMeetings(server.pool);
    await server.pool.query("UPDATE usuarios SET rol='superadmin' WHERE id=$1", [users.get(employees[4])]);
    const sourceBefore = (await server.pool.query('SELECT * FROM organigrama_cargo_asignaciones WHERE proyecto_id=$1 ORDER BY id', [projects[0]])).rows;
    const url = `/api/project-meetings/reviewers/${projects[0]}`;
    const selection = { startCargoId:positions[0],reviewers:{ [positions[0]]:employees[0],[positions[1]]:employees[5] } };
    try {
      expect((await request(app).get(url).set('x-test-user',auth(0))).status).toBe(403);
      const detail = await request(app).get(url).set('x-test-user',auth(4));
      expect(detail.status).toBe(200);
      expect(detail.body.snapshot.issue).toContain('Más de un PMC');
      expect((await request(app).get('/api/project-meetings/reviewers').set('x-test-user',auth(4))).body.some((project: { id: string }) => project.id === projects[0])).toBe(true);
      const invalid = { ...selection,reviewers:{...selection.reviewers,[positions[1]]:employees[4]} };
      expect((await request(app).put(url).set('x-test-user',auth(4)).send({ selection:invalid,reason:'No pertenece' })).status).toBe(400);
      const saved = await request(app).put(url).set('x-test-user',auth(4)).send({ selection,reason:'Un revisor por obra en CEO' });
      expect(saved.status,JSON.stringify(saved.body)).toBe(200);
      expect(saved.body.snapshot.path.map((step: { employeeId: string }) => step.employeeId)).toEqual([employees[0],employees[5]]);
      const branch = (await server.pool.query('SELECT snapshot FROM meeting_project_branches WHERE artifact_id=$1 AND project_id=$2', [meeting,projects[0]])).rows[0];
      expect(branch.snapshot.path).toEqual(saved.body.snapshot.path);
      expect(branch.snapshot.team.some((member: { id: string }) => member.id === employees[1])).toBe(true);
      expect((await server.pool.query('SELECT * FROM organigrama_cargo_asignaciones WHERE proyecto_id=$1 ORDER BY id', [projects[0]])).rows).toEqual(sourceBefore);
      expect((await server.pool.query("SELECT detail FROM meeting_project_audit WHERE project_id=$1 AND operation='reviewers-designated'", [projects[0]])).rows[0].detail.reason).toBe('Un revisor por obra en CEO');
      expect((await server.pool.query('SELECT responsible_id,assignment_origin FROM meeting_review_actions WHERE id=$1', [actions[0]])).rows[0]).toEqual({responsible_id:employees[3],assignment_origin:'manual'});
    } finally {
      await server.pool.query('DELETE FROM meeting_project_reviewer_settings WHERE project_id=$1', [projects[0]]);
      await server.pool.query('DELETE FROM organigrama_cargo_asignaciones WHERE id=ANY($1::text[])', [duplicateIds]);
      await server.pool.query("UPDATE usuarios SET rol='employee:member' WHERE id=$1", [users.get(employees[4])]);
      await refreshProjectMeetings(server.pool);
    }
  });
  it('reasigna automáticamente al último asignado por obra, no por sincronización o edición', async () => {
    const duplicate = `${prefix}-dated-pmc`;
    await server.pool.query("UPDATE organigrama_cargo_asignaciones SET source_assigned_at='2026-10-01T00:00:00Z',source_updated_at='2026-12-01T00:00:00Z' WHERE proyecto_id=$1", [projects[0]]);
    await server.pool.query("INSERT INTO organigrama_cargo_asignaciones(id,cargo_id,empleado_id,proyecto_id,source_assigned_at) VALUES($1,$2,$3,$4,'2026-10-10T00:00:00Z')", [duplicate,positions[1],employees[2],projects[0]]);
    try {
      await refreshProjectMeetings(server.pool);
      const branches = (await server.pool.query('SELECT * FROM meeting_project_branches WHERE artifact_id=$1 ORDER BY project_id',[meeting])).rows;
      expect(branches[0].snapshot.pmcId).toBe(employees[2]);
      expect(branches[1].snapshot.pmcId).toBe(employees[5]);
      expect(branches[0].snapshot.team).toHaveLength(3);
      await server.pool.query('UPDATE organigrama_cargo_asignaciones SET synced_at=NOW() WHERE proyecto_id=$1',[projects[0]]);
      await refreshProjectMeetings(server.pool);
      expect((await server.pool.query('SELECT * FROM meeting_project_branches WHERE artifact_id=$1 ORDER BY project_id',[meeting])).rows).toEqual(branches);
      expect((await server.pool.query('SELECT responsible_id,assignment_origin FROM meeting_review_actions WHERE id=$1',[actions[0]])).rows[0]).toEqual({responsible_id:employees[3],assignment_origin:'manual'});
      const diagnostic = await readFile(new URL('../../deploy/scripts/check-meeting-project-readiness.sql', import.meta.url),'utf8');
      const result = await server.pool.query(diagnostic.replace(/^\\set.*$/gm,''));
      const statement = (result as unknown as { rows: Record<string,unknown>[] }[]).find((item) => item.rows[0]?.jsonb_build_object);
      const data = statement!.rows[0].jsonb_build_object as { projects: { id:string;team: Parameters<typeof buildProjectSnapshot>[0] }[]; positions: Parameters<typeof buildProjectSnapshot>[1] };
      expect(buildProjectSnapshot(data.projects.find((project) => project.id === projects[0])!.team,data.positions).pmcId).toBe(employees[2]);
    } finally {
      await server.pool.query('DELETE FROM organigrama_cargo_asignaciones WHERE id=$1',[duplicate]);
      await server.pool.query('UPDATE organigrama_cargo_asignaciones SET source_assigned_at=NULL,source_updated_at=NULL WHERE proyecto_id=$1',[projects[0]]);
      await refreshProjectMeetings(server.pool);
    }
  });
  it('converge, permite devolución y termina en PMC con resultado inmutable', async () => {
    await request(app).put(`${endpoint}/actions/${actions[1]}`).set('x-test-user',auth(1)).send({ due_date:'2026-11-02' });
    const branches = (await server.pool.query('SELECT * FROM meeting_project_branches WHERE artifact_id=$1 ORDER BY project_id',[meeting])).rows;
    for (const [index,branch] of branches.entries()) {
      const response = await request(app).post(`${endpoint}/workflow`).set('x-test-user',auth(index)).send({ branch_id:branch.id,command:'approve' });
      expect(response.status,JSON.stringify(response.body)).toBe(200);
      if (index === 0) expect((await request(app).get(endpoint).set('x-test-user',auth(5))).status).toBe(403);
    }
    expect((await request(app).get(endpoint).set('x-test-user',auth(5))).body.actions).toHaveLength(2);
    expect((await request(app).post(`${endpoint}/workflow`).set('x-test-user',auth(5)).send({ branch_id:branches[0].id,command:'return',reason:'Revisar plazo' })).status).toBe(200);
    expect((await request(app).post(`${endpoint}/workflow`).set('x-test-user',auth(0)).send({ branch_id:branches[0].id,command:'approve' })).status).toBe(200);
    for (const branch of branches) expect((await request(app).post(`${endpoint}/workflow`).set('x-test-user',auth(5)).send({ branch_id:branch.id,command:'approve' })).status).toBe(200);
    expect((await server.pool.query('SELECT status FROM meeting_reviews WHERE artifact_id=$1',[meeting])).rows[0].status).toBe('approved');
    expect((await request(app).put(`${endpoint}/actions/${actions[0]}`).set('x-test-user',auth(3)).send({ title:'Cambio tardío' })).status).toBe(409);
    expect((await request(app).delete(`${endpoint}/actions/${actions[1]}`).set('x-test-user',auth(5)).send({ reason:'Cambio tardío' })).status).toBe(409);
  });

  async function createClient(project: string | null) {
    const artifactId = randomUUID();
    const actionId = randomUUID();
    extraMeetings.push(artifactId);
    await server.pool.query("INSERT INTO google_drive_artifacts(id,connection_id,folder_id,google_file_id,name,mime_type,artifact_type,content_text) VALUES($1::uuid,$2,$3,$1::text,'Cliente QA','text/plain','transcript','Decisión del cliente')",[artifactId,connection,folder]);
    await server.pool.query("INSERT INTO meeting_reviews(artifact_id,project_id,analysis_status,meeting_kind) VALUES($1,$2,'completed','REUNION_CLIENTE')",[artifactId,project]);
    await server.pool.query("INSERT INTO meeting_review_actions(id,artifact_id,project_id,project_name,title,source_ref,due_date,origin) VALUES($1,$2,$3,$3,'Acción de cliente','Fragmento original','2026-11-01','ai')",[actionId,artifactId,project]);
    await refreshProjectMeetings(server.pool);
    return { artifactId, actionId, url:`/api/project-meetings/${artifactId}` };
  }

  it('reunión de cliente sin delineante llega a PMC, escalar no altera su recorrido y borrar exige motivo/auditoría', async () => {
    await server.pool.query('DELETE FROM organigrama_cargo_asignaciones WHERE id=$1',[`${projects[0]}-low`]);
    const client = await createClient(projects[0]);
    const detail = (await request(app).get(client.url).set('x-test-user',auth(5))).body;
    expect(detail.branches).toHaveLength(1);
    expect(detail.branches[0].snapshot.path).toHaveLength(1);
    expect(detail.branches[0].can_review).toBe(true);
    expect((await request(app).get(client.url).set('x-test-user',auth(3))).status).toBe(403);
    expect((await request(app).put(`${client.url}/actions/${client.actionId}/escalation`).set('x-test-user',auth(5)).send({ escalated:true })).status).toBe(200);
    const escalated = (await request(app).get(client.url).set('x-test-user',auth(3))).body;
    expect(escalated.actions[0]).toMatchObject({ escalated_by:employees[5] });
    expect(escalated.actions[0].escalated_at).toBeTruthy();
    expect((await request(app).get(client.url).set('x-test-user',auth(5))).body.branches[0].cursor).toBe(0);
    expect((await request(app).delete(`${client.url}/actions/${client.actionId}`).set('x-test-user',auth(3)).send({})).status).toBe(400);
    expect((await request(app).delete(`${client.url}/actions/${client.actionId}`).set('x-test-user',auth(3)).send({ reason:'Duplicada según transcripción' })).status).toBe(200);
    const deletion = (await server.pool.query("SELECT detail FROM meeting_project_audit WHERE artifact_id=$1 AND operation='action-deleted'",[client.artifactId])).rows[0].detail;
    expect(deletion.before.source_ref).toBe('Fragmento original');
    expect(deletion.reason).toBe('Duplicada según transcripción');
  });

  it('conserva responsables adicionales con permisos por proyecto, auditoría y Director limitado', async () => {
    const client = await createClient(projects[0]);
    const url = `${client.url}/actions/${client.actionId}/responsibles`;
    expect((await request(app).put(url).set('x-test-user',auth(5)).send({ kind:'employee',id:employees[1] })).status).toBe(400);
    expect((await request(app).put(url).set('x-test-user',auth(4)).send({ kind:'employee',id:employees[3] })).status).toBe(403);
    expect((await request(app).get(client.url).set('x-test-user',auth(3))).status).toBe(403);
    expect((await request(app).put(url).set('x-test-user',auth(5)).send({ kind:'employee',id:employees[3] })).status).toBe(200);
    const director = await request(app).get(client.url).set('x-test-user',auth(3));
    expect(director.status).toBe(200);
    expect(director.body.actions[0].responsibles).toEqual(expect.arrayContaining([expect.objectContaining({ responsible_id:employees[3] })]));
    expect(director.body.content_text).toBe('');
    expect((await request(app).get('/api/project-meetings').set('x-test-user',auth(3))).body.items.map((item: { id: string }) => item.id)).toContain(client.artifactId);
    expect((await request(app).get('/api/meetings/work-items').set('x-test-user',auth(3))).body.items.map((item: { actionId: string }) => item.actionId)).toContain(client.actionId);
    const pmc = (await request(app).get(client.url).set('x-test-user',auth(5))).body;
    expect(pmc.content_text).toBe('Decisión del cliente');
    expect(pmc.actions[0].responsible_id).toBe(employees[5]);
    expect(pmc.branches[0].cursor).toBe(0);
    expect((await request(app).put(`${client.url}/actions/${client.actionId}`).set('x-test-user',auth(5)).send({ responsible_id:employees[5] })).status).toBe(200);
    expect((await request(app).get(client.url).set('x-test-user',auth(3))).status).toBe(200);
    expect((await request(app).delete(url).set('x-test-user',auth(5)).send({ kind:'employee',id:employees[3] })).status).toBe(200);
    expect((await request(app).get(client.url).set('x-test-user',auth(3))).status).toBe(403);
    const audit = (await server.pool.query("SELECT detail FROM meeting_project_audit WHERE artifact_id=$1 AND operation='action-changed' ORDER BY id DESC LIMIT 1", [client.artifactId])).rows[0].detail;
    expect(audit.before.responsibles).toHaveLength(1);
    expect(audit.after.responsibles).toHaveLength(0);
    expect((await request(app).post(`${client.url}/workflow`).set('x-test-user',auth(5)).send({ branch_id:pmc.branches[0].id,command:'approve' })).status).toBe(200);
    expect((await request(app).put(url).set('x-test-user',auth(5)).send({ kind:'employee',id:employees[3] })).status).toBe(409);
  });
  it('una caída del directorio conserva acciones y reintenta sin sobrescribir asignaciones manuales', async () => {
    await server.pool.query('UPDATE meeting_project_feature SET directory_available=FALSE');
    const client = await createClient(projects[1]);
    const before = (await request(app).get(client.url).set('x-test-user',auth(1))).body;
    expect(before.actions[0]).toMatchObject({ responsible_id:null,assignment_origin:'unassigned' });
    expect(before.branches[0].snapshot.issue).toContain('Club LYN no disponible');
    expect((await request(app).post(`${client.url}/actions`).set('x-test-user',auth(1)).send({ project_id:projects[1],title:'Manual',responsible_id:employees[3] })).status).toBe(200);
    await server.pool.query('UPDATE meeting_project_feature SET directory_available=TRUE');
    await refreshProjectMeetings(server.pool);
    const after = (await request(app).get(client.url).set('x-test-user',auth(1))).body;
    expect(after.actions).toHaveLength(2);
    expect(after.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id:client.actionId,responsible_id:employees[5],assignment_origin:'pmc_default' }),
      expect.objectContaining({ title:'Manual',responsible_id:employees[3],assignment_origin:'manual' }),
    ]));
  });

  it('sin PMC permite cierre del delineante sin permisos de PMC; la pausa mantiene las guardas', async () => {
    await server.pool.query('DELETE FROM organigrama_cargo_asignaciones WHERE id=$1',[`${projects[1]}-pmc`]);
    const client = await createClient(projects[1]);
    const detail = (await request(app).get(client.url).set('x-test-user',auth(1))).body;
    expect(detail.actions[0].responsible_id).toBeNull();
    expect(detail.branches[0].snapshot).toMatchObject({issue:null,pmcId:null,path:[{employeeId:employees[1],cargo: 'Delineante',final:true}]});
    expect(detail.actions[0]).toMatchObject({can_delete:false,can_escalate:false});
    expect((await request(app).post(`${client.url}/workflow`).set('x-test-user',auth(1)).send({ branch_id:detail.branches[0].id,command:'approve' })).status).toBe(409);
    expect((await request(app).delete(`${client.url}/actions/${client.actionId}`).set('x-test-user',auth(1)).send({reason:'Sin permiso PMC'})).status).toBe(403);
    expect((await request(app).put(`${client.url}/actions/${client.actionId}/escalation`).set('x-test-user',auth(1)).send({escalated:true})).status).toBe(403);
    expect((await request(app).put(`${client.url}/actions/${client.actionId}`).set('x-test-user',auth(1)).send({responsible_id:employees[1]})).status).toBe(200);
    expect((await request(app).post(`${client.url}/workflow`).set('x-test-user',auth(1)).send({ branch_id:detail.branches[0].id,command:'approve' })).status).toBe(200);
    expect((await server.pool.query('SELECT status FROM meeting_reviews WHERE artifact_id=$1',[client.artifactId])).rows[0].status).toBe('approved');
    expect((await server.pool.query('SELECT snapshot FROM meeting_project_branches WHERE artifact_id=$1',[client.artifactId])).rows[0].snapshot.pmcId).toBeNull();
    await server.pool.query('UPDATE meeting_project_feature SET enabled=FALSE');
    expect((await request(app).put(`${client.url}/actions/${client.actionId}`).set('x-test-user',auth(1)).send({ title:'No' })).status).toBe(409);
    expect((await request(app).put(`/api/meetings/${client.artifactId}/actions/${client.actionId}`).send({ title:'No' })).status).toBe(409);
    expect((await request(app).get('/api/operations/escalations')).status).toBe(409);
    expect((await request(app).get(client.url).set('x-test-user',auth(1))).status).toBe(200);
    await server.pool.query('UPDATE meeting_project_feature SET enabled=TRUE');
  });
  it('lee las vinculaciones sin esperar al bloqueo de la sincronización del directorio', async () => {
    await server.pool.query("UPDATE usuarios SET rol='superadmin' WHERE id=$1", [users.get(employees[4])]);
    const meetingClient = await createClient(null);
    const locker = await server.pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM meeting_reviews WHERE artifact_id=$1 FOR UPDATE', [meetingClient.artifactId]);
      await locker.query('SELECT 1 FROM meeting_review_actions WHERE artifact_id=$1 FOR UPDATE', [meetingClient.artifactId]);
      const detail = await request(app).get(`/api/project-meetings/resolution/${meetingClient.artifactId}`).set('x-test-user', auth(4)).timeout({ response: 1500, deadline: 2000 });
      expect(detail.status).toBe(200);
      expect(detail.body.actions[0].id).toBe(meetingClient.actionId);
      expect((await locker.query('SELECT project_id FROM meeting_review_actions WHERE id=$1', [meetingClient.actionId])).rows[0].project_id).toBeNull();
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      await server.pool.query('DELETE FROM google_drive_artifacts WHERE id=$1', [meetingClient.artifactId]);
      await server.pool.query("UPDATE usuarios SET rol='employee:member' WHERE id=$1", [users.get(employees[4])]);
    }
  });
  it('vincula acciones manualmente con auditoría, sin perder responsables ni dejar ramas fantasma', async () => {
    await server.pool.query("UPDATE usuarios SET rol='superadmin' WHERE id=$1", [users.get(employees[4])]);
    const client = await createClient(null);
    const path = `/api/project-meetings/resolution/${client.artifactId}`;
    await server.pool.query("UPDATE meeting_review_actions SET responsible_source='manual',assignment_origin='manual',responsible_id=$2,responsible_kind='employee',responsible=$2 WHERE id=$1", [client.actionId, employees[3]]);
    try {
      expect((await request(app).get(path).set('x-test-user',auth(0))).status).toBe(403);
      const listing = await request(app).get('/api/project-meetings/resolution').set('x-test-user',auth(4));
      expect(listing.body.items.map((item: {id:string}) => item.id)).toContain(client.artifactId);
      const normalList = await request(app).get('/api/project-meetings').set('x-test-user',auth(4));
      expect(normalList.body.items.find((item: {id:string}) => item.id === client.artifactId)).toMatchObject({ resolution_only:true });
      const sidebar = await request(app).get(client.url).set('x-test-user',auth(4));
      expect(sidebar.status).toBe(200);
      expect(sidebar.body).toMatchObject({ resolution_only:true, actions:[], branches:[] });
      expect(sidebar.body).not.toHaveProperty('summary');
      expect(sidebar.body).not.toHaveProperty('transcript');
      expect((await request(app).get(client.url).set('x-test-user',auth(0))).status).toBe(403);
      const detail = await request(app).get(path).set('x-test-user',auth(4));
      expect(detail.body.actions[0].id).toBe(client.actionId);
      expect(detail.body).not.toHaveProperty('summary');
      const body = { actionIds: [client.actionId], projectId: projects[0], reason: 'Confirmado por responsable de la reunión' };
      expect((await request(app).put(path).set('x-test-user',auth(4)).send({...body, reason:''})).status).toBe(400);
      expect((await request(app).put(path).set('x-test-user',auth(4)).send({...body, actionIds:[client.actionId, randomUUID()]})).status).toBe(409);
      expect((await server.pool.query('SELECT project_id FROM meeting_review_actions WHERE id=$1',[client.actionId])).rows[0].project_id).toBeNull();
      expect((await request(app).put(path).set('x-test-user',auth(4)).send({...body,projectId:'not-a-project'})).status).toBe(400);
      const saved = await request(app).put(path).set('x-test-user',auth(4)).send(body);
      expect(saved.status,JSON.stringify(saved.body)).toBe(200);
      expect((await server.pool.query('SELECT project_id,responsible_id,assignment_origin FROM meeting_review_actions WHERE id=$1',[client.actionId])).rows[0]).toEqual({project_id:projects[0],responsible_id:employees[3],assignment_origin:'manual'});
      expect((await server.pool.query('SELECT project_id FROM meeting_project_branches WHERE artifact_id=$1',[client.artifactId])).rows).toEqual([{project_id:projects[0]}]);
      expect((await server.pool.query("SELECT detail FROM meeting_project_audit WHERE artifact_id=$1 AND operation='projects-linked-manually'",[client.artifactId])).rows[0].detail.reason).toBe(body.reason);
      expect((await request(app).put(path).set('x-test-user',auth(4)).send(body)).status).toBe(409);
      await server.pool.query("UPDATE meeting_reviews SET status='approved' WHERE artifact_id=$1",[client.artifactId]);
      expect((await request(app).put(path).set('x-test-user',auth(4)).send(body)).status).toBe(409);
    } finally { await server.pool.query("UPDATE usuarios SET rol='employee:member' WHERE id=$1", [users.get(employees[4])]); }
  });
  it('rechaza PMCs de respaldo y no aplica excepciones antiguas ajenas al cargo de la obra', async () => {
    await server.pool.query("UPDATE usuarios SET rol='superadmin' WHERE id=$1", [users.get(employees[4])]);
    const path = `/api/project-meetings/reviewers/${projects[1]}`;
    try {
      const selection = { startCargoId:null,reviewers:{},fallbackPmc:{ employeeId:employees[5],cargoId:positions[1] } };
      expect((await request(app).put(path).set('x-test-user',auth(0)).send({selection,reason:'Confirmado'})).status).toBe(403);
      expect((await request(app).put(path).set('x-test-user',auth(4)).send({selection:{...selection,fallbackPmc:{employeeId:employees[4],cargoId:positions[1]}},reason:'Confirmado'})).status).toBe(400);
      const response = await request(app).put(path).set('x-test-user',auth(4)).send({selection,reason:'Confirmado por Dirección para esta obra'});
      expect(response.status,JSON.stringify(response.body)).toBe(400);
      expect(response.body.error).toContain('en esta obra');
      expect((await request(app).put(path).set('x-test-user',auth(4)).send({selection:{startCargoId:null,reviewers:{[positions[1]]:employees[5]}},reason:'Promoción no permitida'})).status).toBe(400);
      expect((await server.pool.query('SELECT 1 FROM meeting_project_reviewer_settings WHERE project_id=$1',[projects[1]])).rowCount).toBe(0);
      await server.pool.query('INSERT INTO meeting_project_reviewer_settings(project_id,selection,updated_by) VALUES($1,$2::jsonb,$3)',[projects[1],JSON.stringify(selection),'legacy-test']);
      const legacy = await request(app).get(path).set('x-test-user',auth(4));
      expect(legacy.body.snapshot.pmcId).toBeNull();
      expect(legacy.body.snapshot.issue).toBeNull();
      expect(legacy.body.snapshot.path).toMatchObject([{employeeId:employees[1],cargo:'Delineante',final:true}]);
      expect(legacy.body).not.toHaveProperty('candidates');
      expect((await server.pool.query('SELECT 1 FROM organigrama_cargo_asignaciones WHERE proyecto_id=$1 AND cargo_id=$2',[projects[1],positions[1]])).rowCount).toBe(0);
      await server.pool.query('INSERT INTO organigrama_cargo_asignaciones(id,cargo_id,empleado_id,proyecto_id) VALUES($1,$2,$3,$4)',[`${projects[1]}-pmc`,positions[1],employees[2],projects[1]]);
      await refreshProjectMeetings(server.pool);
      const restored = await request(app).get(path).set('x-test-user',auth(4));
      expect(restored.body.snapshot.pmcId).toBe(employees[2]);
      await server.pool.query('DELETE FROM organigrama_cargo_asignaciones WHERE id=$1',[`${projects[1]}-pmc`]);
      await server.pool.query('DELETE FROM meeting_project_reviewer_settings WHERE project_id=$1',[projects[1]]);
    } finally { await server.pool.query("UPDATE usuarios SET rol='employee:member' WHERE id=$1", [users.get(employees[4])]); }
  });
  it('rechaza la activación insegura sin incorporar borradores ni cambiar el indicador', async () => {
    await server.pool.query('UPDATE meeting_project_feature SET enabled=FALSE');
    await server.pool.query("UPDATE usuarios SET rol='superadmin' WHERE id=$1", [users.get(employees[4])]);
    const before = (await server.pool.query('SELECT COUNT(*) FROM meeting_project_drafts')).rows[0].count;
    try {
      await server.pool.query('UPDATE organigrama_cargo_asignaciones SET activo=FALSE WHERE id=$1',[`${projects[1]}-low`]);
      const blockedTeam = await request(app).put('/api/project-meetings/mode').set('x-test-user',auth(4)).send({ enabled:true });
      expect(blockedTeam.status).toBe(409);
      expect(blockedTeam.body.error).toContain('cadena de revisión');
      await server.pool.query('UPDATE organigrama_cargo_asignaciones SET activo=TRUE WHERE id=$1',[`${projects[1]}-low`]);
      await createClient(null);
      const blockedProject = await request(app).put('/api/project-meetings/mode').set('x-test-user',auth(4)).send({ enabled:true });
      expect(blockedProject.status).toBe(409);
      expect(blockedProject.body.error).toContain('vincular sus obras');
      expect((await server.pool.query('SELECT enabled FROM meeting_project_feature')).rows[0].enabled).toBe(false);
      expect((await server.pool.query('SELECT COUNT(*) FROM meeting_project_drafts')).rows[0].count).toBe(before);
    } finally {
      await server.pool.query("UPDATE usuarios SET rol='employee:member' WHERE id=$1", [users.get(employees[4])]);
    }
  });
});
