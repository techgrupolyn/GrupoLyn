import { createHmac, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encryptGoogleDriveSecret } from '../google-drive.ts';
import { acquireSummaryLock, releaseSummaryLock, createSummaryQueue, markSummaryMessagesReviewed, publicSummaryJob } from '../summary-jobs.ts';
import { evidencePayload, evidenceResponse } from './summary-evidence-fixtures.ts';
import { createWhatsAppInbox } from '../whatsapp-reliability.ts';

const generation = vi.hoisted(() => vi.fn());
const mediaGeneration = vi.hoisted(() => vi.fn());
vi.mock('../geminiService.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../geminiService.ts')>(),
  callGeminiWithPromptResult: generation,
  callGeminiWithMediaResult: mediaGeneration,
}));

const databaseUrl = process.env.QA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('QA reuniones contra PostgreSQL aislado', () => {
  let server: typeof import('../server.ts');
  const artifactId = randomUUID();
  const connectionId = randomUUID();
  const folderId = randomUUID();
  const employeeId = `qa-${artifactId}`;
  const projectId = `qa-project-${artifactId}`;
  let userId: number;
  const secret = 'isolated-qa-session-secret';
  const payload = Buffer.from(JSON.stringify({ usuario: 'qa', nombre: 'Revisor QA', rol: 'superadmin', exp: Date.now() + 3600000 })).toString('base64url');
  const authorization = `Bearer ${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
  const endpoint = `/api/meetings/${artifactId}`;

  beforeAll(async () => {
    const target = new URL(databaseUrl!);
    if (target.hostname !== '127.0.0.1' || target.pathname !== '/lyn_qa_retest') throw new Error('QA requiere una base aislada local');
    process.env.DATABASE_URL = databaseUrl;
    process.env.CEO_SESSION_SECRET = secret;
    process.env.SUPABASE_SYNC_ENABLED = 'false';
    process.env.EVOLUTION_BACKGROUND_SYNC_ENABLED = 'false';
    process.env.MEETING_AI_BACKGROUND_ANALYSIS_ENABLED = 'false';
    process.env.GOOGLE_DRIVE_CLIENT_ID = 'qa-synthetic';
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'qa-synthetic';
    process.env.GOOGLE_DRIVE_OAUTH_REDIRECT_URI = 'http://127.0.0.1/qa/callback';
    process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    server = await import('../server.ts');
    await server.pool.query(await readFile(new URL('../../schema.sql', import.meta.url), 'utf8'));
    await server.ensureDatabaseSchema();
    await server.pool.query(`INSERT INTO google_drive_connections (id, google_email, access_token_encrypted, refresh_token_encrypted, created_by) VALUES ($1, $2, 'unused', 'unused', 'qa')`, [connectionId, `${connectionId}@example.test`]);
    await server.pool.query("UPDATE google_drive_connections SET access_token_encrypted = $2, expires_at = NOW() + INTERVAL '1 hour' WHERE id = $1", [connectionId, encryptGoogleDriveSecret('synthetic-qa-token', process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY)]);
    await server.pool.query(`INSERT INTO google_drive_folders (id, connection_id, google_folder_id, label, created_by) VALUES ($1::uuid, $2, $1::text, 'Carpeta QA', 'qa')`, [folderId, connectionId]);
    await server.pool.query(`INSERT INTO google_drive_artifacts (id, connection_id, folder_id, google_file_id, name, mime_type, artifact_type, content_text) VALUES ($1::uuid, $2, $3, $1::text, 'Comité de obra · QA', 'text/plain', 'transcript', 'PMC: Persona QA. Obra: QA. Revisar planos.')`, [artifactId, connectionId, folderId]);
    await server.pool.query(`INSERT INTO meeting_reviews (artifact_id, summary, analysis_status, workflow_stage, status) VALUES ($1, 'Resumen QA', 'completed', 'pmc', 'pending')`, [artifactId]);
    await server.pool.query("INSERT INTO empleados (id, nombre, numero, email) VALUES ($1, 'Persona QA', $1, $2)", [employeeId, `${employeeId}@example.test`]);
    await server.pool.query("INSERT INTO proyectos (id, nombre) VALUES ($1, 'Obra QA')", [projectId]);
    const user = await server.pool.query("INSERT INTO usuarios (usuario, email, auth_provider, rol) VALUES ($1, $2, 'supabase', 'employee:interiorista') RETURNING id", [employeeId, `${employeeId}@example.test`]);
    userId = user.rows[0].id;
  }, 60000);

  afterAll(async () => {
    if (server) {
      try {
        await server.pool.query('DELETE FROM google_drive_connections WHERE id = $1', [connectionId]);
        await server.pool.query('DELETE FROM usuarios WHERE id = $1', [userId]);
        await server.pool.query('DELETE FROM empleados WHERE id = $1', [employeeId]);
        await server.pool.query('DELETE FROM proyectos WHERE id = $1', [projectId]);
        await server.pool.query('DELETE FROM organigrama_cargos WHERE id = ANY($1::varchar[])', [[`${employeeId}-pmc`, `${employeeId}-operations`, `${employeeId}-director`]]);
      } finally {
        await server.pool.end();
      }
    }
  });

  it.each(['miembro', 'organigrama', 'global', 'ambiguo', 'inactivo', 'manual', 'existente', 'analisis', 'con-tarea'])('completa PMC desde Club LYN de forma segura: %s', async (mode) => {
    const meeting = randomUUID();
    const project = `qa-pmc-project-${meeting}`;
    const employee = `qa-pmc-${meeting}`;
    const other = `qa-other-${meeting}`;
    const position = `qa-position-${meeting}`;
    try {
      await server.pool.query('INSERT INTO proyectos (id,nombre) VALUES ($1,$1)', [project]);
      await server.pool.query("INSERT INTO empleados (id,nombre,activo) VALUES ($1,'PMC de Club', $3),($2,'Otro PMC',TRUE)", [employee, other, mode !== 'inactivo']);
      if (mode === 'organigrama' || mode === 'global') {
        await server.pool.query("INSERT INTO organigrama_cargos (id,nombre) VALUES ($1,'PMC')", [position]);
        await server.pool.query('INSERT INTO organigrama_cargo_asignaciones (id,cargo_id,empleado_id,proyecto_id) VALUES ($1,$1,$2,$3)', [position, employee, mode === 'global' ? null : project]);
      } else {
        await server.pool.query("INSERT INTO proyecto_asignaciones (id,proyecto_id,empleado_id,rol_en_proyecto,origen) VALUES ($1,$2,$1,'pmc','supabase')", [employee, project]);
        if (mode === 'ambiguo') await server.pool.query("INSERT INTO proyecto_asignaciones (id,proyecto_id,empleado_id,rol_en_proyecto,origen) VALUES ($1,$2,$1,'pmc','supabase')", [other, project]);
      }
      await server.pool.query("INSERT INTO google_drive_artifacts (id,connection_id,folder_id,google_file_id,name,mime_type,artifact_type,content_text) VALUES ($1::uuid,$2,$3,$1::text,'Reunión cliente','text/plain','transcript',$4)", [meeting, connectionId, folderId, `Obra: ${project}. Revisar planos.`]);
      await server.pool.query("INSERT INTO meeting_reviews (artifact_id,project_id,project_name,summary,manual_revision,pmc,pmc_employee_id) VALUES ($1,$2,$2,'Resumen conservado',$3,$4,$5)", [meeting, project, mode === 'manual' || mode === 'existente', mode === 'existente' ? 'Otro PMC' : null, mode === 'existente' ? other : null]);
      if (mode === 'con-tarea') await server.pool.query("INSERT INTO meeting_review_actions (id,artifact_id,title,responsible) VALUES ($1,$2,'Revisar planos','Sin identificar')", [randomUUID(), meeting]);
      if (mode === 'analisis') {
        generation.mockResolvedValueOnce({ text: JSON.stringify({ summary: 'Resumen IA', identity: { project_name: project }, actions: [] }), fallback: false, provider: 'qa', model: 'stub' });
        const response = await request(server.app).post(`/api/meetings/${meeting}/analyze`).set('Authorization', authorization).send({});
        expect(response.status, JSON.stringify(response.body)).toBe(200);
      } else {
        const response = await request(server.app).post('/api/meetings/retag').set('Authorization', authorization).send({});
        expect(response.status, JSON.stringify(response.body)).toBe(200);
      }
      const row = (await server.pool.query('SELECT pmc,pmc_employee_id,summary,project_id,manual_revision,updated_at FROM meeting_reviews WHERE artifact_id=$1', [meeting])).rows[0];
      const unresolved = ['global', 'ambiguo', 'inactivo'].includes(mode);
      expect(row).toMatchObject({ project_id: project, pmc: unresolved ? null : mode === 'existente' ? 'Otro PMC' : 'PMC de Club', pmc_employee_id: unresolved ? null : mode === 'existente' ? other : employee });
      if (mode !== 'analisis') expect(row.summary).toBe('Resumen conservado');
      if (mode === 'con-tarea') expect((await server.pool.query('SELECT project_id,responsible_id,responsible_kind FROM meeting_review_actions WHERE artifact_id=$1', [meeting])).rows[0]).toEqual({ project_id: project, responsible_id: null, responsible_kind: null });
      if (mode === 'manual' || mode === 'existente') expect(row.manual_revision).toBe(true);
      await request(server.app).post('/api/meetings/retag').set('Authorization', authorization).send({});
      expect((await server.pool.query('SELECT pmc,pmc_employee_id FROM meeting_reviews WHERE artifact_id=$1', [meeting])).rows[0]).toEqual({ pmc: row.pmc, pmc_employee_id: row.pmc_employee_id });
    } finally {
      generation.mockReset();
      await server.pool.query('DELETE FROM google_drive_artifacts WHERE id=$1', [meeting]);
      await server.pool.query('DELETE FROM organigrama_cargos WHERE id=$1', [position]);
      await server.pool.query('DELETE FROM proyectos WHERE id=$1', [project]);
      await server.pool.query('DELETE FROM empleados WHERE id=ANY($1::varchar[])', [[employee, other]]);
    }
  });

  it('lista cuentas con historial voluminoso, sin historial e inactivas con conteos independientes', async () => {
    const accountIds = [`qa-list-${randomUUID()}`, `qa-list-${randomUUID()}`];
    try {
      for (const accountId of accountIds) await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      await server.pool.query('UPDATE whatsapp_accounts SET activo=FALSE WHERE id=$1', [accountIds[1]]);
      await server.pool.query("INSERT INTO chats(id,account_id,nombre) SELECT $1 || '::' || series, $1, 'QA' FROM generate_series(1,250) series", [accountIds[0]]);
      await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto) SELECT $1 || '::message-' || series, $1 || '::1', $1, 'QA', 'Historial sintético' FROM generate_series(1,1500) series", [accountIds[0]]);
      const response = await request(server.app).get('/api/whatsapp-accounts').set('Authorization', authorization);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.find((account: { id: string }) => account.id === accountIds[0])).toMatchObject({ chats_count: 250, messages_count: 1500, activo: true });
      expect(response.body.find((account: { id: string }) => account.id === accountIds[1])).toMatchObject({ chats_count: 0, messages_count: 0, activo: false });
      expect((await request(server.app).get('/api/whatsapp-accounts')).status).toBe(401);
    } finally {
      await server.pool.query('DELETE FROM chats WHERE account_id=ANY($1::varchar[])', [accountIds]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=ANY($1::varchar[])', [accountIds]);
    }
  });

  it.each(['open', 'close', 'connecting', 'unknown', 'network'])('consulta el estado real de la cuenta seleccionada sin modificarla: %s', async (state) => {
    const accountId = `qa-status-${randomUUID()}`;
    const instance = `qa-instance-${randomUUID()}`;
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(state === 'unknown' ? {} : { instance: { state } }), { status: 200 }));
    if (state === 'network') fetcher.mockReset().mockRejectedValue(new Error('Evolution inaccesible'));
    vi.stubGlobal('fetch', fetcher);
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name,activo) VALUES($1,$1,$2,FALSE)', [accountId, instance]);
      const response = await request(server.app).get(`/api/whatsapp-accounts/${accountId}/status`).set('Authorization', authorization);
      expect(response.status).toBe(['unknown', 'network'].includes(state) ? 502 : 200);
      if (response.status === 200) expect(response.body).toEqual({ account_id: accountId, state, connected: state === 'open' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`/instance/connectionState/${instance}`), expect.any(Object));
      expect((await server.pool.query('SELECT activo FROM whatsapp_accounts WHERE id=$1', [accountId])).rows[0].activo).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it('el estado de WhatsApp exige administrador y cuenta existente', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('No debe contactar Evolution'));
    vi.stubGlobal('fetch', fetcher);
    try {
      const url = '/api/whatsapp-accounts/qa-inexistente/status';
      const limitedPayload = Buffer.from(JSON.stringify({ rol: 'employee:delineante', exp: Date.now() + 60000 })).toString('base64url');
      const limitedToken = `${limitedPayload}.${createHmac('sha256', secret).update(limitedPayload).digest('base64url')}`;
      expect((await request(server.app).get(url)).status).toBe(401);
      expect((await request(server.app).get(url).set('x-extension-activation', randomUUID())).status).toBe(401);
      expect((await request(server.app).get(url).set('Authorization', `Bearer ${limitedToken}`)).status).toBe(403);
      expect((await request(server.app).get(url).set('Authorization', authorization)).status).toBe(404);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([true, false])('desvincula solo la instancia elegida y conserva sus datos (activo=%s)', async (active) => {
    const accountId = `qa-disconnect-${randomUUID()}`;
    const instance = `instance-${randomUUID()}`;
    const chatId = `${accountId}::123@s.whatsapp.net`;
    const invitationId = randomUUID();
    const activationId = randomUUID();
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'SUCCESS', error: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name,activo) VALUES($1,$1,$2,$3)', [accountId, instance, active]);
      await server.pool.query("INSERT INTO chats(id,account_id,nombre) VALUES($1,$2,'QA')", [chatId, accountId]);
      await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto) VALUES($1,$2,$3,'QA','Historial conservado')", [randomUUID(), chatId, accountId]);
      await server.pool.query("INSERT INTO extension_invitations(id,code_hash,expires_at,created_by,account_id) VALUES($1::uuid,$1::text,NOW()+INTERVAL '1 hour','qa',$2)", [invitationId, accountId]);
      await server.pool.query('INSERT INTO extension_activations(id,invitation_id,account_id) VALUES($1,$2,$3)', [activationId, invitationId, accountId]);
      const response = await request(server.app).post(`/api/whatsapp-accounts/${accountId}/disconnect`).set('Authorization', authorization).send({});
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toEqual({ ok: true, account_id: accountId, connected: false });
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`/instance/logout/${instance}`), expect.objectContaining({ method: 'DELETE' }));
      expect((await server.pool.query('SELECT activo FROM whatsapp_accounts WHERE id=$1', [accountId])).rows[0].activo).toBe(active);
      expect((await server.pool.query('SELECT texto FROM mensajes WHERE account_id=$1', [accountId])).rows[0].texto).toBe('Historial conservado');
      expect((await server.pool.query('SELECT revoked_at FROM extension_activations WHERE id=$1', [activationId])).rows[0].revoked_at).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      await server.pool.query('DELETE FROM chats WHERE id=$1', [chatId]);
      await server.pool.query('DELETE FROM extension_activations WHERE id=$1', [activationId]);
      await server.pool.query('DELETE FROM extension_invitations WHERE id=$1', [invitationId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it('desvinculación exige administrador y cuenta existente', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('No debe contactar Evolution'));
    vi.stubGlobal('fetch', fetcher);
    try {
      const url = '/api/whatsapp-accounts/qa-inexistente/disconnect';
      expect((await request(server.app).post(url)).status).toBe(401);
      expect((await request(server.app).post(url).set('x-extension-activation', randomUUID())).status).toBe(401);
      const limitedPayload = Buffer.from(JSON.stringify({ rol: 'employee:delineante', exp: Date.now() + 60000 })).toString('base64url');
      const limitedToken = `${limitedPayload}.${createHmac('sha256', secret).update(limitedPayload).digest('base64url')}`;
      expect((await request(server.app).post(url).set('Authorization', `Bearer ${limitedToken}`)).status).toBe(403);
      expect((await request(server.app).post(url).set('Authorization', authorization)).status).toBe(404);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['close', 'open', 'unknown', 'network'])('desvinculación no oculta errores y permite repetir una sesión cerrada: %s', async (state) => {
    const accountId = `qa-disconnect-${randomUUID()}`;
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 400 })).mockResolvedValueOnce(new Response(JSON.stringify(state === 'unknown' ? {} : { instance: { state } }), { status: 200 }));
    if (state === 'network') fetcher.mockReset().mockRejectedValue(new Error('Conexión caída'));
    vi.stubGlobal('fetch', fetcher);
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      const response = await request(server.app).post(`/api/whatsapp-accounts/${accountId}/disconnect`).set('Authorization', authorization);
      expect(response.status).toBe(state === 'close' ? 200 : 502);
      expect((await server.pool.query('SELECT activo FROM whatsapp_accounts WHERE id=$1', [accountId])).rows[0].activo).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(state === 'network' ? 1 : 2);
    } finally {
      vi.unstubAllGlobals();
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it('A-01: guardar, devolver con motivo y aprobar no generan error SQL', async () => {
    for (const command of ['save', 'return', 'approve']) {
      await server.pool.query("UPDATE meeting_reviews SET workflow_stage = 'pmc', status = 'pending' WHERE artifact_id = $1", [artifactId]);
      const response = await request(server.app).post(`${endpoint}/workflow`).set('Authorization', authorization).send({ command, reason: 'Falta revisar evidencia' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
    const audit = await server.pool.query('SELECT actor, detail FROM meeting_review_versions WHERE artifact_id = $1', [artifactId]);
    expect(audit.rows).toHaveLength(3);
    expect(audit.rows.every((row) => row.actor === 'Revisor QA')).toBe(true);
    expect(audit.rows.some((row) => row.detail.includes('Falta revisar evidencia'))).toBe(true);
  });

  it('M-04: minutos vacíos permanecen nulos y la edición deja evento', async () => {
    const actionId = randomUUID();
    await server.pool.query(`INSERT INTO meeting_review_actions (id, artifact_id, title) VALUES ($1, $2, 'Antes')`, [actionId, artifactId]);
    const response = await request(server.app).put(`${endpoint}/actions/${actionId}`).set('Authorization', authorization).send({ title: 'Después', estimated_minutes: '', due_date: '2026-09-30' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.estimated_minutes).toBeNull();
    const audit = await server.pool.query("SELECT detail FROM meeting_review_versions WHERE artifact_id = $1 AND stage = 'edición'", [artifactId]);
    expect(audit.rows.some((row) => row.detail.includes('Después'))).toBe(true);
    const versions = await server.pool.query("SELECT snapshot FROM meeting_review_versions WHERE artifact_id = $1 AND stage = 'edición' ORDER BY created_at DESC", [artifactId]);
    expect(versions.rows[0].snapshot.actions.some((action: { title: string }) => action.title === 'Después')).toBe(true);
  });

  it('M-04: un fallo al auditar revierte la edición completa', async () => {
    const actionId = randomUUID();
    await server.pool.query(`INSERT INTO meeting_review_actions (id, artifact_id, title) VALUES ($1, $2, 'No modificar')`, [actionId, artifactId]);
    await server.pool.query(`CREATE OR REPLACE FUNCTION qa_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fallo de auditoría simulado'; END $$; CREATE TRIGGER qa_audit_failure BEFORE INSERT ON meeting_review_versions FOR EACH ROW EXECUTE FUNCTION qa_reject_audit()`);
    try {
      const response = await request(server.app).put(`${endpoint}/actions/${actionId}`).set('Authorization', authorization).send({ title: 'Cambio rechazado' });
      expect(response.status).toBe(500);
      const saved = await server.pool.query('SELECT title FROM meeting_review_actions WHERE id = $1', [actionId]);
      expect(saved.rows[0].title).toBe('No modificar');
    } finally {
      await server.pool.query('DROP TRIGGER qa_audit_failure ON meeting_review_versions; DROP FUNCTION qa_reject_audit()');
    }
  });

  it('M-05: rechaza obra en texto libre y proyectos ajenos', async () => {
    for (const fields of [{ project_name: 'Inventada' }, { project_id: 'proyecto-ajeno' }]) {
      const response = await request(server.app).post(`${endpoint}/actions`).set('Authorization', authorization).send({ title: 'Acción QA', ...fields });
      expect(response.status, JSON.stringify(response.body)).toBe(400);
    }
  });

  it('no expone reuniones ni filtros sin sesión', async () => {
    expect((await request(server.app).get(endpoint)).status).toBe(401);
    expect((await request(server.app).get('/api/meetings/filter-options')).status).toBe(401);
  });

  it('analiza sin aviso de Meet y conserva la protección de revisiones humanas', async () => {
    expect((await server.pool.query('SELECT artifact_id FROM meeting_recording_notices WHERE artifact_id = $1', [artifactId])).rowCount).toBe(0);
    const protectedReview = await request(server.app).post(`${endpoint}/analyze`).set('Authorization', authorization).send({});
    expect(protectedReview.status).toBe(409);
    expect(protectedReview.body.error).toContain('revisión humana protegida');
    await server.pool.query("UPDATE meeting_reviews SET manual_revision = FALSE, status = 'draft' WHERE artifact_id = $1", [artifactId]);
    generation.mockResolvedValue({ text: JSON.stringify({ summary: 'Resumen controlado QA', actions: [], decisions: ['Revisar planos [min 00:02:02]'], relevant_information: ['Los sanitarios suben un 5 % en octubre'] }), fallback: false, provider: 'qa', model: 'stub' });
    const response = await request(server.app).post(`${endpoint}/analyze`).set('Authorization', authorization).send({});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const detail = await request(server.app).get(endpoint).set('Authorization', authorization);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.relevant_information).toContain('5 %');
    expect(detail.body.decisions).toContain('00:02:02');
  });

  it('A-02: no inicia análisis manual de una carpeta desactivada', async () => {
    generation.mockClear();
    await server.pool.query('UPDATE google_drive_folders SET enabled = FALSE WHERE id = $1', [folderId]);
    try {
      const response = await request(server.app).post(`${endpoint}/analyze`).set('Authorization', authorization).send({});
      expect(response.status).toBe(409);
      expect(generation).not.toHaveBeenCalled();
    } finally {
      await server.pool.query('UPDATE google_drive_folders SET enabled = TRUE WHERE id = $1', [folderId]);
    }
  });

  it('M-03: un archivo vacío no crea borrador ni llama a IA', async () => {
    const emptyId = randomUUID();
    await server.pool.query(`INSERT INTO google_drive_artifacts (id, connection_id, folder_id, google_file_id, name, mime_type, artifact_type, content_text) VALUES ($1::uuid, $2, $3, $1::text, 'Documento vacío QA', 'text/plain', 'document', '')`, [emptyId, connectionId, folderId]);
    generation.mockClear();
    const response = await request(server.app).post(`/api/meetings/${emptyId}/analyze`).set('Authorization', authorization).send({});
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('extraer texto');
    expect(generation).not.toHaveBeenCalled();
    const reviews = await server.pool.query('SELECT artifact_id FROM meeting_reviews WHERE artifact_id = $1', [emptyId]);
    expect(reviews.rows).toHaveLength(0);
  });

  it('A-04: no acepta el PMC inventado por IA en un título fuera de convención', async () => {
    await server.pool.query("UPDATE google_drive_artifacts SET name = 'Reunión semanal obras', content_text = 'Laura y Marta conversan sobre varias obras.' WHERE id = $1", [artifactId]);
    generation.mockResolvedValue({ text: JSON.stringify({ summary: 'Resumen controlado', meeting_kind: 'COMITE_OBRA', pmc: 'Laura', actions: [] }), fallback: false, provider: 'qa', model: 'stub' });
    const response = await request(server.app).post(`${endpoint}/analyze`).set('Authorization', authorization).send({});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result = await server.pool.query('SELECT pmc, pmc_employee_id, meeting_kind FROM meeting_reviews WHERE artifact_id = $1', [artifactId]);
    expect(result.rows[0]).toEqual({ pmc: null, pmc_employee_id: null, meeting_kind: 'MEET' });
  });

  it('Director del directorio accede a reuniones ajenas y a administración sin asignación', async () => {
    const directorPayload = Buffer.from(JSON.stringify({ usuario: 'qa-director', rol: 'employee:director', exp: Date.now() + 3600000 })).toString('base64url');
    const auth = `Bearer ${directorPayload}.${createHmac('sha256', secret).update(directorPayload).digest('base64url')}`;
    expect((await request(server.app).get(endpoint).set('Authorization', auth)).status).toBe(200);
    expect((await request(server.app).get('/api/directory').set('Authorization', auth)).status).toBe(200);
    expect((await request(server.app).get('/api/meetings/filter-options').set('Authorization', auth)).status).toBe(200);
  });

  it('acceso restringido: solo ve una reunión tras ser vinculado; nunca puede editar como interiorista', async () => {
    const employeePayload = Buffer.from(JSON.stringify({ id: userId, usuario: employeeId, rol: 'employee:interiorista', exp: Date.now() + 3600000 })).toString('base64url');
    const auth = `Bearer ${employeePayload}.${createHmac('sha256', secret).update(employeePayload).digest('base64url')}`;
    expect((await request(server.app).get(endpoint).set('Authorization', auth)).status).toBe(404);
    const actionId = randomUUID();
    await server.pool.query("INSERT INTO meeting_review_actions (id, artifact_id, title, responsible_id, responsible_kind) VALUES ($1, $2, 'Tarea de Persona QA', $3, 'employee')", [actionId, artifactId, employeeId]);
    expect((await request(server.app).get(endpoint).set('Authorization', auth)).status).toBe(200);
    expect((await request(server.app).get('/api/meetings/filter-options').set('Authorization', auth)).status).toBe(200);
    expect((await request(server.app).put(`${endpoint}/actions/${actionId}`).set('Authorization', auth).send({ title: 'Prohibido' })).status).toBe(403);
  });

  it('M-07: Delineante guarda su reunión pero no una ajena ni operaciones globales', async () => {
    const editorId = `qa-editor-${randomUUID()}`;
    const reviewId = randomUUID();
    let editorUserId: number | undefined;
    try {
      await server.pool.query("INSERT INTO empleados(id,nombre,numero,email) VALUES($1,'Editor QA',$1,$2)", [editorId, `${editorId}@example.test`]);
      editorUserId = (await server.pool.query("INSERT INTO usuarios(usuario,email,auth_provider,rol) VALUES($1,$2,'supabase','employee:delineante') RETURNING id", [editorId, `${editorId}@example.test`])).rows[0].id;
      await server.pool.query("INSERT INTO organigrama_cargos(id,nombre) VALUES($1,'Delineante')", [editorId]);
      await server.pool.query('INSERT INTO organigrama_cargo_asignaciones(id,cargo_id,empleado_id) VALUES($1,$1,$1)', [editorId]);
      await server.pool.query("INSERT INTO google_drive_artifacts(id,connection_id,google_file_id,name,mime_type,artifact_type,content_text) VALUES($1,$2,$3,'QA permisos','text/plain','transcript','Sintético')", [reviewId, connectionId, reviewId]);
      await server.pool.query("INSERT INTO meeting_reviews(artifact_id,analysis_status,summary) VALUES($1,'completed','Antes')", [reviewId]);
      await server.pool.query("INSERT INTO meeting_review_actions(id,artifact_id,title,responsible_id,responsible_kind) VALUES($1,$2,'Tarea QA',$3,'employee')", [randomUUID(), reviewId, editorId]);
      const tokenPayload = Buffer.from(JSON.stringify({ id: editorUserId, usuario: editorId, nombre: 'Editor QA', rol: 'employee:delineante', exp: Date.now() + 60000 })).toString('base64url');
      const auth = `Bearer ${tokenPayload}.${createHmac('sha256', secret).update(tokenPayload).digest('base64url')}`;
      const saved = await request(server.app).put(`/api/meetings/${reviewId}`).set('Authorization', auth).send({ summary: 'Guardado por editor QA' });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect((await server.pool.query('SELECT summary FROM meeting_reviews WHERE artifact_id=$1', [reviewId])).rows[0].summary).toBe('Guardado por editor QA');
      expect((await request(server.app).put(endpoint).set('Authorization', auth).send({ summary: 'No permitido' })).status).toBe(403);
      expect((await request(server.app).post('/api/meetings/retag').set('Authorization', auth).send({})).status).toBe(403);
      expect((await request(server.app).put('/api/meetings/configuration').set('Authorization', auth).send({})).status).toBe(403);
      expect((await server.pool.query('SELECT actor FROM meeting_review_versions WHERE artifact_id=$1', [reviewId])).rows.some((row) => row.actor === 'Editor QA')).toBe(true);
    } finally {
      await server.pool.query('DELETE FROM google_drive_artifacts WHERE id=$1', [reviewId]);
      await server.pool.query('DELETE FROM organigrama_cargo_asignaciones WHERE id=$1', [editorId]);
      await server.pool.query('DELETE FROM organigrama_cargos WHERE id=$1', [editorId]);
      if (editorUserId) await server.pool.query('DELETE FROM usuarios WHERE id=$1', [editorUserId]);
      await server.pool.query('DELETE FROM empleados WHERE id=$1', [editorId]);
    }
  });

  it.each(['COMITE_OBRA', 'REUNION_CLIENTE'])('cadena completa %s con cuatro usuarios, devolución, permisos, avisos y snapshots', async (meetingKind) => {
    const prefix = `qa-chain-${randomUUID()}`;
    const reviewId = randomUUID();
    const actionId = randomUUID();
    const stages = ['delineante', 'pmc', 'operations', 'director'];
    const labels = ['Delineante', 'PMC / Jefe de Proyectos', 'Dirección de Operaciones', 'Director General'];
    const roles = ['employee:delineante', 'employee:pmc', 'employee:direccion_de_operaciones', 'employee:director_general'];
    const people = stages.map((stage, index) => ({ id: `${prefix}-${stage}`, name: `QA ${labels[index]}`, role: roles[index], auth: '', userId: 0 }));
    const originalSettings = (await server.pool.query('SELECT committee_workflow,client_workflow FROM meeting_agent_settings WHERE id=TRUE')).rows[0];
    const route = `/api/meetings/${reviewId}`;
    const transition = (index: number, command: string, reason?: string) => request(server.app).post(`${route}/workflow`).set('Authorization', people[index].auth).send({ command, reason });
    const checkTurn = async (stage: string | null) => {
      for (const [index, person] of people.entries()) {
        const response = await request(server.app).get('/api/meetings/work-items').set('Authorization', person.auth);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const notices = response.body.items.filter((item: { artifactId: string; kind: string }) => item.artifactId === reviewId && item.kind === 'review');
        expect(notices.length, `${meetingKind}: turno ${stage}, usuario ${stages[index]}`).toBe(stages[index] === stage ? 1 : 0);
        if (notices.length) expect(notices[0].unread).toBe(true);
        const mine = await request(server.app).get('/api/meetings?filter=mine').set('Authorization', person.auth);
        expect(mine.status).toBe(200);
        expect(mine.body.items.some((item: { id: string }) => item.id === reviewId)).toBe(stages[index] === stage);
        const approved = await request(server.app).get('/api/meetings?filter=approved').set('Authorization', person.auth);
        expect(approved.status).toBe(200);
        expect(approved.body.items.some((item: { id: string }) => item.id === reviewId)).toBe(stage === null);
      }
    };
    try {
      await server.pool.query('UPDATE meeting_agent_settings SET committee_workflow=$1::jsonb,client_workflow=$1::jsonb WHERE id=TRUE', [JSON.stringify(stages)]);
      await server.pool.query("INSERT INTO proyectos(id,nombre) VALUES($1,'Proyecto cadena QA')", [prefix]);
      for (const [index, person] of people.entries()) {
        await server.pool.query('INSERT INTO empleados(id,nombre,numero,email) VALUES($1,$2,$1,$3)', [person.id, person.name, `${person.id}@example.test`]);
        person.userId = (await server.pool.query("INSERT INTO usuarios(usuario,email,auth_provider,rol) VALUES($1,$2,'supabase',$3) RETURNING id", [person.id, `${person.id}@example.test`, person.role])).rows[0].id;
        await server.pool.query('INSERT INTO organigrama_cargos(id,nombre) VALUES($1,$2)', [person.id, labels[index]]);
        await server.pool.query('INSERT INTO organigrama_cargo_asignaciones(id,cargo_id,empleado_id,proyecto_id) VALUES($1,$1,$1,$2)', [person.id, prefix]);
        await server.pool.query('INSERT INTO proyecto_asignaciones(id,proyecto_id,empleado_id,rol_en_proyecto) VALUES($1,$2,$1,$3)', [person.id, prefix, labels[index]]);
        const signedPayload = Buffer.from(JSON.stringify({ id: person.userId, usuario: person.id, nombre: person.name, rol: person.role, exp: Date.now() + 60000 })).toString('base64url');
        person.auth = `Bearer ${signedPayload}.${createHmac('sha256', secret).update(signedPayload).digest('base64url')}`;
      }
      await server.pool.query("INSERT INTO google_drive_artifacts(id,connection_id,google_file_id,name,mime_type,artifact_type,content_text) VALUES($1,$2,$3,'Cadena completa QA','text/plain','transcript','Fixture sintético sin datos personales')", [reviewId, connectionId, reviewId]);
      await server.pool.query("INSERT INTO meeting_reviews(artifact_id,analysis_status,summary,workflow_stage,status,project_id,meeting_kind,pmc_employee_id) VALUES($1,'completed','Resumen inicial','agent','draft',$2,$3,$4)", [reviewId, prefix, meetingKind, people[1].id]);
      await server.pool.query("INSERT INTO meeting_review_actions(id,artifact_id,title,status,project_id) VALUES($1,$2,'Revisar planos QA','pending',$3)", [actionId, reviewId, prefix]);
      expect((await transition(0, 'approve')).status).toBe(409);
      await server.pool.query("UPDATE meeting_review_actions SET responsible_id=$2,responsible_kind='employee' WHERE id=$1", [actionId, people[0].id]);
      const initial = await transition(0, 'save');
      expect(initial.status, JSON.stringify(initial.body)).toBe(200);
      expect(initial.body.meeting.workflow_stage).toBe('delineante');
      await checkTurn('delineante');
      expect((await transition(1, 'approve')).status).toBe(403);
      const edit = await request(server.app).put(`${route}/actions/${actionId}`).set('Authorization', people[0].auth).send({ title: 'Planos corregidos por Delineante QA' });
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      for (const index of [0, 1]) {
        const advanced = await transition(index, 'approve');
        expect(advanced.status, JSON.stringify(advanced.body)).toBe(200);
        expect(advanced.body.meeting).toMatchObject({ workflow_stage: stages[index + 1], status: 'pending' });
        await checkTurn(stages[index + 1]);
        expect((await transition(index, 'approve')).status).toBe(403);
      }
      const returned = await transition(2, 'return', 'Corregir el plano antes de continuar');
      expect(returned.status, JSON.stringify(returned.body)).toBe(200);
      expect(returned.body.meeting).toMatchObject({ workflow_stage: 'pmc', status: 'returned', returned_reason: 'Corregir el plano antes de continuar' });
      await checkTurn('pmc');
      const saved = await transition(1, 'save');
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body.meeting.workflow_stage).toBe('pmc');
      for (const index of [1, 2, 3]) {
        const advanced = await transition(index, 'approve');
        expect(advanced.status, JSON.stringify(advanced.body)).toBe(200);
        expect(advanced.body.meeting).toMatchObject({ workflow_stage: stages[Math.min(index + 1, 3)], status: index === 3 ? 'approved' : 'pending' });
        await checkTurn(index === 3 ? null : stages[index + 1]);
      }
      const final = (await server.pool.query('SELECT status,approved_by,approved_at FROM meeting_reviews WHERE artifact_id=$1', [reviewId])).rows[0];
      expect(final.status).toBe('approved');
      expect(final.approved_by).toBe(people[3].name);
      expect(final.approved_at).toBeTruthy();
      const versions = (await server.pool.query('SELECT actor,actor_id,actor_role,snapshot,event_type,previous_stage,stage,detail FROM meeting_review_versions WHERE artifact_id=$1 ORDER BY created_at', [reviewId])).rows;
      expect(versions).toHaveLength(9);
      for (const [index, person] of people.entries()) {
        const auditRole = index < 2 ? labels[index] : person.role;
        expect(versions.some((version) => version.actor === person.name && version.actor_id === String(person.userId) && version.actor_role === auditRole)).toBe(true);
      }
      expect(versions.every((version) => version.snapshot?.meeting && Array.isArray(version.snapshot.actions))).toBe(true);
      expect(versions.at(-1).snapshot.meeting.status).toBe('approved');
      expect(versions.at(-1).snapshot.actions[0].title).toBe('Planos corregidos por Delineante QA');
      expect(versions.some((version) => version.event_type === 'return' && version.previous_stage === 'operations' && version.stage === 'pmc' && version.detail.includes('Corregir el plano'))).toBe(true);
    } finally {
      await server.pool.query('DELETE FROM google_drive_artifacts WHERE id=$1', [reviewId]);
      await server.pool.query('DELETE FROM organigrama_cargo_asignaciones WHERE cargo_id=ANY($1::text[])', [people.map((person) => person.id)]);
      await server.pool.query('DELETE FROM organigrama_cargos WHERE id=ANY($1::text[])', [people.map((person) => person.id)]);
      await server.pool.query('DELETE FROM usuarios WHERE usuario=ANY($1::text[])', [people.map((person) => person.id)]);
      await server.pool.query('DELETE FROM empleados WHERE id=ANY($1::text[])', [people.map((person) => person.id)]);
      await server.pool.query('DELETE FROM proyectos WHERE id=$1', [prefix]);
      await server.pool.query('UPDATE meeting_agent_settings SET committee_workflow=$1::jsonb,client_workflow=$2::jsonb WHERE id=TRUE', [JSON.stringify(originalSettings.committee_workflow), JSON.stringify(originalSettings.client_workflow)]);
    }
  });

  it.each(['employee:interiorista', 'employee:director_general', 'superadmin'])('tareas propias principales y adicionales sin mezclarlas con aprobaciones para %s', async (role) => {
    const ownEmployeeId = `qa-work-${randomUUID()}`;
    const ownReviewId = randomUUID();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    try {
      await server.pool.query("INSERT INTO empleados(id,nombre,numero,email) VALUES($1,'Usuario tareas QA',$1,$2)", [ownEmployeeId, `${ownEmployeeId}@example.test`]);
      const ownUserId = (await server.pool.query("INSERT INTO usuarios(usuario,email,auth_provider,rol) VALUES($1,$2,'supabase',$3) RETURNING id", [ownEmployeeId, `${ownEmployeeId}@example.test`, role])).rows[0].id;
      const session = Buffer.from(JSON.stringify({ id: ownUserId, usuario: ownEmployeeId, nombre: 'Usuario tareas QA', rol: role, exp: Date.now() + 60000 })).toString('base64url');
      const auth = `Bearer ${session}.${createHmac('sha256', secret).update(session).digest('base64url')}`;
      await server.pool.query("INSERT INTO google_drive_artifacts(id,connection_id,google_file_id,name,mime_type,artifact_type,content_text) VALUES($1,$2,$3,'Tareas QA','text/plain','transcript','Sintético')", [ownReviewId, connectionId, ownReviewId]);
      await server.pool.query("INSERT INTO meeting_reviews(artifact_id,analysis_status,status,workflow_stage) VALUES($1,'completed','approved','director')", [ownReviewId]);
      for (const [index, id] of ids.entries()) {
        await server.pool.query("INSERT INTO meeting_review_actions(id,artifact_id,title,status,responsible_id,responsible_kind) VALUES($1,$2,$3,'pending',$4,'employee')", [id, ownReviewId, `Tarea QA ${index}`, index === 0 ? ownEmployeeId : employeeId]);
      }
      await server.pool.query("INSERT INTO meeting_review_action_responsibles(action_id,employee_id,responsible_id,responsible_kind,responsible_name) VALUES($1,$2,$2,'employee','Usuario tareas QA')", [ids[1], ownEmployeeId]);
      const work = await request(server.app).get('/api/meetings/work-items').set('Authorization', auth);
      expect(work.status, JSON.stringify(work.body)).toBe(200);
      const tasks = work.body.items.filter((item: { kind: string }) => item.kind === 'action');
      expect(tasks.map((item: { actionId: string }) => item.actionId).sort()).toEqual(ids.slice(0, 2).sort());
      const read = await request(server.app).post('/api/meetings/work-items/read').set('Authorization', auth).send({ keys: tasks.map((item: { key: string }) => item.key) });
      expect(read.status).toBe(200);
      const afterRead = await request(server.app).get('/api/meetings/work-items').set('Authorization', auth);
      expect(afterRead.body.actions).toBe(2);
      expect(afterRead.body.items.filter((item: { kind: string }) => item.kind === 'action').every((item: { unread: boolean }) => !item.unread)).toBe(true);
      const mine = await request(server.app).get('/api/meetings?filter=mine').set('Authorization', auth);
      expect(mine.status).toBe(200);
      expect(mine.body.items).toEqual([]);
      const approved = await request(server.app).get('/api/meetings?filter=approved').set('Authorization', auth);
      expect(approved.status).toBe(200);
      expect(approved.body.items.some((item: { id: string }) => item.id === ownReviewId)).toBe(true);
      if (role === 'employee:interiorista') {
        expect((await request(server.app).post(`/api/meetings/${ownReviewId}/workflow`).set('Authorization', auth).send({ command: 'approve' })).status).toBe(403);
      }
      await server.pool.query("UPDATE meeting_review_actions SET status='done' WHERE id=$1", [ids[0]]);
      await server.pool.query('DELETE FROM meeting_review_action_responsibles WHERE action_id=$1 AND employee_id=$2', [ids[1], ownEmployeeId]);
      const cleared = await request(server.app).get('/api/meetings/work-items').set('Authorization', auth);
      expect(cleared.body.actions).toBe(0);
      if (role === 'employee:interiorista') {
        await server.pool.query('UPDATE meeting_review_actions SET responsible_id=NULL,responsible_kind=NULL WHERE id=$1', [ids[0]]);
        const hidden = await request(server.app).get('/api/meetings?filter=approved').set('Authorization', auth);
        expect(hidden.body.items.some((item: { id: string }) => item.id === ownReviewId)).toBe(false);
      }
    } finally {
      await server.pool.query('DELETE FROM google_drive_artifacts WHERE id=$1', [ownReviewId]);
      await server.pool.query('DELETE FROM usuarios WHERE usuario=$1', [ownEmployeeId]);
      await server.pool.query('DELETE FROM empleados WHERE id=$1', [ownEmployeeId]);
    }
  });

  it('M-05: un PMC global no recibe proyectos ajenos en el selector', async () => {
    await server.pool.query("INSERT INTO organigrama_cargos (id, nombre) VALUES ($1, 'PMC')", [`${employeeId}-pmc`]);
    await server.pool.query('INSERT INTO organigrama_cargo_asignaciones (id, cargo_id, empleado_id) VALUES ($1, $1, $2)', [`${employeeId}-pmc`, employeeId]);
    await server.pool.query('UPDATE meeting_reviews SET pmc_employee_id = $2, project_id = NULL WHERE artifact_id = $1', [artifactId, employeeId]);
    const response = await request(server.app).get(endpoint).set('Authorization', authorization);
    expect(response.status).toBe(200);
    expect(response.body.available_projects).toEqual([]);
  });

  it('A-01: omite cargos vacíos y registra la omisión', async () => {
    await server.pool.query("UPDATE meeting_reviews SET workflow_stage = 'agent', status = 'draft', project_id = $2 WHERE artifact_id = $1", [artifactId, projectId]);
    await server.pool.query("UPDATE meeting_review_actions SET status = 'cancelled' WHERE artifact_id = $1", [artifactId]);
    const response = await request(server.app).post(`${endpoint}/workflow`).set('Authorization', authorization).send({ command: 'approve' });
    expect(response.status).toBe(200);
    expect(response.body.meeting.workflow_stage).toBe('pmc');
    const event = await server.pool.query('SELECT detail FROM meeting_review_versions WHERE artifact_id = $1 ORDER BY created_at DESC LIMIT 1', [artifactId]);
    expect(event.rows[0].detail).toMatch(/omitid.*Delineante/i);
  });

  it('A-01: una persona con dos cargos consecutivos no tiene que aprobar dos veces', async () => {
    await server.pool.query("INSERT INTO organigrama_cargos (id, nombre) VALUES ($1, 'Dirección de Operaciones')", [`${employeeId}-operations`]);
    await server.pool.query('INSERT INTO organigrama_cargo_asignaciones (id, cargo_id, empleado_id) VALUES ($1, $1, $2)', [`${employeeId}-operations`, employeeId]);
    const response = await request(server.app).post(`${endpoint}/workflow`).set('Authorization', authorization).send({ command: 'approve' });
    expect(response.status).toBe(200);
    expect(response.body.meeting.status).toBe('approved');
    const event = await server.pool.query('SELECT detail, snapshot FROM meeting_review_versions WHERE artifact_id = $1 ORDER BY created_at DESC LIMIT 1', [artifactId]);
    expect(event.rows[0].detail).toMatch(/misma persona/i);
    expect(event.rows[0].snapshot.meeting.status).toBe('approved');
  });

  it('lista, filtros y paginación ejecutan SQL válido con datos reales', async () => {
    for (const query of ['', '?page=1&page_size=10', '?project_id=' + projectId, '?pmc_employee_id=' + employeeId, '?date_from=2026-09-01&date_to=2026-09-30&sort=oldest', '?filter=pending']) {
      const response = await request(server.app).get('/api/meetings' + query).set('Authorization', authorization);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(Array.isArray(response.body.items)).toBe(true);
    }
  });

  it('M-04: también revierte guardado, creación, borrado y flujo si falla su evento', async () => {
    const actionId = randomUUID();
    await server.pool.query("INSERT INTO meeting_review_actions (id, artifact_id, title, status) VALUES ($1, $2, 'Conservar acción', 'cancelled')", [actionId, artifactId]);
    const previous = await server.pool.query('SELECT summary, status, workflow_stage FROM meeting_reviews WHERE artifact_id = $1', [artifactId]);
    await server.pool.query(`CREATE OR REPLACE FUNCTION qa_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fallo de auditoría simulado'; END $$; CREATE TRIGGER qa_audit_failure BEFORE INSERT ON meeting_review_versions FOR EACH ROW EXECUTE FUNCTION qa_reject_audit()`);
    try {
      const attempts = [
        () => request(server.app).put(endpoint).set('Authorization', authorization).send({ summary: 'Resumen no persistible' }),
        () => request(server.app).post(`${endpoint}/actions`).set('Authorization', authorization).send({ title: 'Acción no persistible' }),
        () => request(server.app).delete(`${endpoint}/actions/${actionId}`).set('Authorization', authorization),
        () => request(server.app).post(`${endpoint}/workflow`).set('Authorization', authorization).send({ command: 'return', reason: 'No persistible' }),
      ];
      for (const attempt of attempts) expect((await attempt()).status).toBe(500);
      const current = await server.pool.query('SELECT summary, status, workflow_stage FROM meeting_reviews WHERE artifact_id = $1', [artifactId]);
      expect(current.rows).toEqual(previous.rows);
      expect((await server.pool.query('SELECT id FROM meeting_review_actions WHERE id = $1', [actionId])).rowCount).toBe(1);
      expect((await server.pool.query("SELECT id FROM meeting_review_actions WHERE artifact_id = $1 AND title = 'Acción no persistible'", [artifactId])).rowCount).toBe(0);
    } finally {
      await server.pool.query('DROP TRIGGER qa_audit_failure ON meeting_review_versions; DROP FUNCTION qa_reject_audit()');
    }
  });

  it('M-06/P-03: aplica la cadena configurada por tipo cliente', async () => {
    const settings = await server.pool.query('SELECT client_workflow FROM meeting_agent_settings WHERE id = TRUE');
    await server.pool.query(`UPDATE meeting_agent_settings SET client_workflow = '["operations"]'::jsonb WHERE id = TRUE`);
    await server.pool.query("UPDATE meeting_reviews SET meeting_kind = 'REUNION_CLIENTE', workflow_stage = 'agent', status = 'draft' WHERE artifact_id = $1", [artifactId]);
    try {
      const response = await request(server.app).post(`${endpoint}/workflow`).set('Authorization', authorization).send({ command: 'approve' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.meeting.workflow_stage).toBe('operations');
    } finally {
      await server.pool.query('UPDATE meeting_agent_settings SET client_workflow = $1::jsonb WHERE id = TRUE', [JSON.stringify(settings.rows[0].client_workflow)]);
    }
  });

  it('M-06: migra la convención antigua a PMC sin sobrescribir convenciones personalizadas', async () => {
    const original = (await server.pool.query('SELECT naming_convention FROM meeting_agent_settings WHERE id=TRUE')).rows[0].naming_convention;
    const corrected = 'Comité de obra · NOMBRE DEL PMC | Reunión cliente · NOMBRE DE LA OBRA';
    try {
      await server.pool.query('UPDATE meeting_agent_settings SET naming_convention=$1 WHERE id=TRUE', ['Comité de obra · NOMBRE DE LA OBRA | Reunión cliente · NOMBRE DE LA OBRA']);
      await server.ensureDatabaseSchema();
      const response = await request(server.app).get('/api/meetings/configuration').set('Authorization', authorization);
      expect(response.status).toBe(200);
      expect(response.body.naming_convention).toBe(corrected);
      const column = await server.pool.query("SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='meeting_agent_settings' AND column_name='naming_convention'");
      expect(column.rows[0].column_default).toContain(corrected);
      await server.ensureDatabaseSchema();
      expect((await server.pool.query('SELECT naming_convention FROM meeting_agent_settings WHERE id=TRUE')).rows[0].naming_convention).toBe(corrected);
      const custom = 'Comité de obra · PMC · FECHA | Reunión cliente · OBRA';
      await server.pool.query('UPDATE meeting_agent_settings SET naming_convention=$1 WHERE id=TRUE', [custom]);
      await server.ensureDatabaseSchema();
      expect((await server.pool.query('SELECT naming_convention FROM meeting_agent_settings WHERE id=TRUE')).rows[0].naming_convention).toBe(custom);
    } finally {
      await server.pool.query('UPDATE meeting_agent_settings SET naming_convention=$1 WHERE id=TRUE', [original]);
    }
  });

  it('M-04: conserva identidad y rol del autor sin contaminar otras transacciones', async () => {
    const result = await server.pool.query("SELECT actor_id, actor_role FROM meeting_review_versions WHERE artifact_id = $1 AND stage = 'edición' ORDER BY created_at DESC LIMIT 1", [artifactId]);
    expect(result.rows[0]).toEqual({ actor_id: 'qa', actor_role: 'superadmin' });
    const context = await server.pool.query("SELECT NULLIF(current_setting('lyn.audit_actor_id', TRUE), '') AS actor_id");
    expect(context.rows[0].actor_id).toBeNull();
  });

  it('P-02: no sobreescribe ni inventa el aviso de Meet', async () => {
    const created = await request(server.app).post(`${endpoint}/recording-notice`).set('Authorization', authorization).send({ confirmed: true, occurred_at: '2026-09-01T10:00:00Z', evidence: 'Organizador QA avisó en Meet al inicio (fixture sintético).' });
    expect(created.status).toBe(201);
    const invalid = await request(server.app).post(`${endpoint}/recording-notice`).set('Authorization', authorization).send({ confirmed: false, occurred_at: '2026-09-01T10:00:00Z', evidence: 'Referencia QA' });
    expect(invalid.status).toBe(400);
    const duplicate = await request(server.app).post(`${endpoint}/recording-notice`).set('Authorization', authorization).send({ confirmed: true, occurred_at: '2026-09-02T10:00:00Z', evidence: 'Otro texto distinto' });
    expect(duplicate.status).toBe(409);
    const notice = await server.pool.query('SELECT actor_id, actor_role, evidence FROM meeting_recording_notices WHERE artifact_id = $1', [artifactId]);
    expect(notice.rows[0]).toMatchObject({ actor_id: 'qa', actor_role: 'superadmin' });
    expect(notice.rows[0].evidence).toContain('fixture sintético');
  });

  it('A-02: desactivar durante la respuesta IA impide persistir el resultado', async () => {
    await server.pool.query("UPDATE meeting_reviews SET manual_revision = FALSE WHERE artifact_id = $1", [artifactId]);
    const previous = await server.pool.query('SELECT summary FROM meeting_reviews WHERE artifact_id = $1', [artifactId]);
    generation.mockImplementationOnce(async () => {
      await server.pool.query('UPDATE google_drive_folders SET enabled = FALSE WHERE id = $1', [folderId]);
      return { text: '{"summary":"Resultado que no debe guardarse","actions":[]}', fallback: false, provider: 'qa', model: 'stub' };
    });
    try {
      const response = await request(server.app).post(`${endpoint}/analyze`).set('Authorization', authorization).send({});
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect((await server.pool.query('SELECT summary FROM meeting_reviews WHERE artifact_id = $1', [artifactId])).rows).toEqual(previous.rows);
    } finally {
      await server.pool.query('UPDATE google_drive_folders SET enabled = TRUE WHERE id = $1', [folderId]);
      await server.pool.query("UPDATE meeting_reviews SET analysis_status = 'completed' WHERE artifact_id = $1", [artifactId]);
    }
  });

  it('no permite a un PMC de otro proyecto editar una reunión solo por tener una acción asignada', async () => {
    await server.pool.query('UPDATE organigrama_cargo_asignaciones SET proyecto_id = $2 WHERE empleado_id = $1', [employeeId, projectId]);
    await server.pool.query('UPDATE meeting_reviews SET project_id = NULL WHERE artifact_id = $1', [artifactId]);
    const employeePayload = Buffer.from(JSON.stringify({ id: userId, usuario: employeeId, rol: 'employee:pmc', exp: Date.now() + 3600000 })).toString('base64url');
    const auth = `Bearer ${employeePayload}.${createHmac('sha256', secret).update(employeePayload).digest('base64url')}`;
    const response = await request(server.app).put(endpoint).set('Authorization', auth).send({ summary: 'Cambio fuera de alcance' });
    expect(response.status).toBe(403);
  });

  it('M-03: entrega incidencia al organizador vinculado y no a usuarios ajenos', async () => {
    const emptyId = randomUUID();
    await server.pool.query(`INSERT INTO google_drive_artifacts (id, connection_id, folder_id, google_file_id, name, mime_type, artifact_type, content_text) VALUES ($1::uuid, $2, $3, $1::text, 'Documento vacío para organizador', 'text/plain', 'document', '')`, [emptyId, connectionId, folderId]);
    await request(server.app).post(`/api/meetings/${emptyId}/analyze`).set('Authorization', authorization).send({});
    const employeePayload = Buffer.from(JSON.stringify({ id: userId, usuario: employeeId, rol: 'employee:pmc', exp: Date.now() + 3600000 })).toString('base64url');
    const auth = `Bearer ${employeePayload}.${createHmac('sha256', secret).update(employeePayload).digest('base64url')}`;
    const before = await request(server.app).get('/api/meetings/work-items').set('Authorization', auth);
    expect(before.body.items.some((item: { artifactId: string }) => item.artifactId === emptyId)).toBe(false);
    const assigned = await request(server.app).put(`/api/meetings/${emptyId}/organizer`).set('Authorization', authorization).send({ employee_id: employeeId });
    expect(assigned.status).toBe(200);
    const after = await request(server.app).get('/api/meetings/work-items').set('Authorization', auth);
    const issue = after.body.items.find((item: { artifactId: string }) => item.artifactId === emptyId);
    expect(issue).toMatchObject({ kind: 'import_error', unread: true });
    expect(issue.detail).toContain('extraer texto');
    const forbidden = await request(server.app).put(`/api/meetings/${emptyId}/organizer`).set('Authorization', auth).send({ employee_id: employeeId });
    expect(forbidden.status).toBe(403);
  });

  it('A-01: devolución usa la etapa realmente revisada tras fusionar cargos', async () => {
    await server.pool.query('UPDATE organigrama_cargo_asignaciones SET proyecto_id = NULL WHERE empleado_id = $1', [employeeId]);
    await server.pool.query("UPDATE meeting_reviews SET workflow_stage = 'director', status = 'pending', analysis_status = 'completed' WHERE artifact_id = $1", [artifactId]);
    await server.pool.query("INSERT INTO meeting_review_versions (id, artifact_id, actor, stage, detail) VALUES ($1, $2, 'qa', 'director', 'Avance histórico de QA')", [randomUUID(), artifactId]);
    await server.pool.query("UPDATE meeting_review_versions SET event_type = 'approve', previous_stage = 'pmc' WHERE artifact_id = $1 AND detail = 'Avance histórico de QA'", [artifactId]);
    const response = await request(server.app).post(`${endpoint}/workflow`).set('Authorization', authorization).send({ command: 'return', reason: 'Revisar tarea' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.meeting.workflow_stage).toBe('pmc');
  });

  it('no sobrescribe una edición humana realizada mientras Gemini responde', async () => {
    await server.pool.query("UPDATE meeting_reviews SET manual_revision = FALSE, analysis_status = 'completed' WHERE artifact_id = $1", [artifactId]);
    generation.mockImplementationOnce(async () => {
      const edited = await request(server.app).put(endpoint).set('Authorization', authorization).send({ summary: 'Resumen protegido por persona QA' });
      expect(edited.status).toBe(200);
      return { text: '{"summary":"Resultado tardío de IA","actions":[]}', fallback: false, provider: 'qa', model: 'stub' };
    });
    const response = await request(server.app).post(`${endpoint}/analyze`).set('Authorization', authorization).send({});
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    const current = await server.pool.query('SELECT summary, manual_revision, analysis_status FROM meeting_reviews WHERE artifact_id = $1', [artifactId]);
    expect(current.rows[0]).toEqual({ summary: 'Resumen protegido por persona QA', manual_revision: true, analysis_status: 'completed' });
  });

  it('el retag y la cola masiva no alteran revisiones protegidas', async () => {
    const previous = await server.pool.query('SELECT * FROM meeting_reviews WHERE artifact_id = $1', [artifactId]);
    const actions = await server.pool.query('SELECT * FROM meeting_review_actions WHERE artifact_id = $1 ORDER BY id', [artifactId]);
    expect((await request(server.app).post('/api/meetings/retag').set('Authorization', authorization).send({})).status).toBe(200);
    const queued = await request(server.app).post('/api/meetings/reanalyze-missing-pmc').set('Authorization', authorization).send({});
    expect(queued.status).toBe(200);
    expect(queued.body.queued).toBe(0);
    expect((await server.pool.query('SELECT * FROM meeting_reviews WHERE artifact_id = $1', [artifactId])).rows).toEqual(previous.rows);
    expect((await server.pool.query('SELECT * FROM meeting_review_actions WHERE artifact_id = $1 ORDER BY id', [artifactId])).rows).toEqual(actions.rows);
  });

  it('A-02: desactivar mientras lista Drive detiene la paginación y la importación', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await server.pool.query('UPDATE google_drive_folders SET enabled = FALSE WHERE id = $1', [folderId]);
      return new Response(JSON.stringify({ nextPageToken: 'not-requested', files: [{ id: 'qa-not-imported', name: 'Notas QA', mimeType: 'text/plain' }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    try {
      const response = await request(server.app).post(`/api/google-drive/folders/${folderId}/sync`).set('Authorization', authorization).send({});
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.imported).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((await server.pool.query('SELECT id FROM google_drive_artifacts WHERE google_file_id = $1', ['qa-not-imported'])).rowCount).toBe(0);
    } finally {
      fetchMock.mockRestore();
      await server.pool.query('UPDATE google_drive_folders SET enabled = TRUE WHERE id = $1', [folderId]);
    }
  });

  it('A-02: desactivar mientras extrae texto evita guardar el archivo', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: folderId, mimeType: 'application/vnd.google-apps.folder' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: 'qa-extraction-stop', name: 'Notas QA', mimeType: 'text/plain' }] })))
      .mockImplementationOnce(async () => {
        await server.pool.query('UPDATE google_drive_folders SET enabled = FALSE WHERE id = $1', [folderId]);
        return new Response('Texto que no debe importarse');
      });
    try {
      const response = await request(server.app).post(`/api/google-drive/folders/${folderId}/sync`).set('Authorization', authorization).send({});
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.imported).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect((await server.pool.query('SELECT id FROM google_drive_artifacts WHERE google_file_id = $1', ['qa-extraction-stop'])).rowCount).toBe(0);
    } finally {
      fetchMock.mockRestore();
      await server.pool.query('UPDATE google_drive_folders SET enabled = TRUE WHERE id = $1', [folderId]);
    }
  });

  it('M-03/P-04: importa documento vacío como incidencia y MP4 solo como referencia', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('alt=media')) return new Response('   ');
      if (new URL(String(url)).pathname.endsWith(`/files/${folderId}`)) return new Response(JSON.stringify({ id: folderId, mimeType: 'application/vnd.google-apps.folder' }));
      return new Response(JSON.stringify({ files: [
        { id: 'qa-empty-import', name: 'Notas vacías QA', mimeType: 'text/plain' },
        { id: 'qa-video-import', name: 'Grabación QA.mp4', mimeType: 'video/mp4' },
      ] }));
    });
    try {
      const response = await request(server.app).post(`/api/google-drive/folders/${folderId}/sync`).set('Authorization', authorization).send({});
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.imported).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const imported = await server.pool.query('SELECT a.google_file_id, a.artifact_type, a.metadata, r.artifact_id AS review_id FROM google_drive_artifacts a LEFT JOIN meeting_reviews r ON r.artifact_id = a.id WHERE a.google_file_id = ANY($1::text[]) ORDER BY a.google_file_id', [['qa-empty-import', 'qa-video-import']]);
      expect(imported.rows[0].metadata.import_error).toBeTruthy();
      expect(imported.rows.every((row) => row.review_id === null)).toBe(true);
      expect(imported.rows[1].artifact_type).toBe('recording');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('la migración puede ejecutarse de nuevo sin perder avisos ni versiones', async () => {
    const versions = await server.pool.query('SELECT count(*) FROM meeting_review_versions WHERE artifact_id = $1', [artifactId]);
    await server.ensureDatabaseSchema();
    expect((await server.pool.query('SELECT count(*) FROM meeting_review_versions WHERE artifact_id = $1', [artifactId])).rows).toEqual(versions.rows);
    expect((await server.pool.query('SELECT artifact_id FROM meeting_recording_notices WHERE artifact_id = $1', [artifactId])).rowCount).toBe(1);
  });

  it('Mi turno y notificaciones respetan la etapa y el proyecto, no solo el cargo PMC', async () => {
    await server.pool.query('UPDATE organigrama_cargo_asignaciones SET proyecto_id = $2 WHERE empleado_id = $1', [employeeId, projectId]);
    await server.pool.query("UPDATE meeting_reviews SET project_id = $2, workflow_stage = 'operations', status = 'pending' WHERE artifact_id = $1", [artifactId, projectId]);
    const employeePayload = Buffer.from(JSON.stringify({ id: userId, usuario: employeeId, rol: 'employee:pmc', exp: Date.now() + 3600000 })).toString('base64url');
    const auth = `Bearer ${employeePayload}.${createHmac('sha256', secret).update(employeePayload).digest('base64url')}`;
    const work = await request(server.app).get('/api/meetings/work-items').set('Authorization', auth);
    expect(work.status).toBe(200);
    expect(work.body.items.some((item: { kind: string; artifactId: string }) => item.kind === 'review' && item.artifactId === artifactId)).toBe(true);
    const mine = await request(server.app).get('/api/meetings?filter=mine').set('Authorization', auth);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.items.some((item: { id: string }) => item.id === artifactId)).toBe(true);
    await server.pool.query("UPDATE meeting_reviews SET workflow_stage = 'delineante' WHERE artifact_id = $1", [artifactId]);
    const otherStage = await request(server.app).get('/api/meetings?filter=mine').set('Authorization', auth);
    expect(otherStage.body.items.some((item: { id: string }) => item.id === artifactId)).toBe(false);
    await server.pool.query("UPDATE meeting_reviews SET project_id = NULL, workflow_stage = 'operations' WHERE artifact_id = $1", [artifactId]);
    const otherProject = await request(server.app).get('/api/meetings/work-items').set('Authorization', auth);
    expect(otherProject.body.items.some((item: { kind: string; artifactId: string }) => item.kind === 'review' && item.artifactId === artifactId)).toBe(false);
  });

  it('no vincula un empleado inactivo aunque conserve una asignación de proyecto', async () => {
    const inactiveId = randomUUID();
    const reviewId = randomUUID();
    await server.pool.query("INSERT INTO empleados (id,nombre,numero,activo) VALUES ($1,'Inactivo QA',$1,FALSE)", [inactiveId]);
    await server.pool.query("INSERT INTO proyecto_asignaciones (id,proyecto_id,empleado_id,rol_en_proyecto) VALUES ($1,$2,$3,'Delineante')", [randomUUID(), projectId, inactiveId]);
    await server.pool.query("UPDATE google_drive_folders SET enabled=TRUE WHERE id=$1", [folderId]);
    await server.pool.query("INSERT INTO google_drive_artifacts (id,connection_id,folder_id,google_file_id,name,mime_type,artifact_type,content_text) VALUES ($1::uuid,$2,$3,$1::text,'Comité de obra · Obra QA','text/plain','transcript','Obra: Obra QA. Inactivo QA revisará los planos.')", [reviewId, connectionId, folderId]);
    generation.mockResolvedValue({ text: JSON.stringify({ summary: 'Resumen QA', actions: [{ title: 'Revisar planos', project_name: 'Obra QA', responsible: 'Inactivo QA', responsible_id: inactiveId }] }), fallback: false, provider: 'qa', model: 'stub' });
    try {
      const response = await request(server.app).post(`/api/meetings/${reviewId}/analyze`).set('Authorization', authorization).send({});
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const actions = await server.pool.query('SELECT responsible_id FROM meeting_review_actions WHERE artifact_id=$1', [reviewId]);
      expect(actions.rows).toHaveLength(1);
      expect(actions.rows[0].responsible_id).toBeNull();
      expect((await server.pool.query('SELECT 1 FROM meeting_review_action_responsibles WHERE employee_id=$1', [inactiveId])).rowCount).toBe(0);
    } finally {
      await server.pool.query('DELETE FROM google_drive_artifacts WHERE id=$1', [reviewId]);
      await server.pool.query('DELETE FROM proyecto_asignaciones WHERE empleado_id=$1', [inactiveId]);
      await server.pool.query('DELETE FROM empleados WHERE id=$1', [inactiveId]);
    }
  });

  it('N-01: repara tipos antiguos de responsable sin alterar el contenido humano', async () => {
    const actionId = randomUUID();
    await server.pool.query("INSERT INTO meeting_review_actions(id,artifact_id,title,responsible_id) VALUES($1,$2,'Acción humana',$3)", [actionId,artifactId,employeeId]);
    await server.pool.query("INSERT INTO meeting_review_action_responsibles(action_id,responsible_id,employee_id,responsible_kind,responsible_name) VALUES($1,$2,$2,'employee','Persona QA')",[actionId,employeeId]);
    await server.ensureDatabaseSchema();
    expect((await server.pool.query('SELECT responsible_kind,title FROM meeting_review_actions WHERE id=$1',[actionId])).rows[0]).toEqual({responsible_kind:'employee',title:'Acción humana'});
    await server.pool.query('DELETE FROM meeting_review_actions WHERE id=$1',[actionId]);
  });

  it('M-03: Calendar vincula al organizador exacto y no reemplaza la selección manual', async () => {
    const imported = randomUUID();
    await server.pool.query("UPDATE google_drive_connections SET scope='https://www.googleapis.com/auth/calendar.events.readonly' WHERE id=$1",[connectionId]);
    await server.pool.query('UPDATE google_drive_folders SET enabled=TRUE WHERE id=$1',[folderId]);
    await server.pool.query("INSERT INTO google_drive_artifacts(id,connection_id,folder_id,google_file_id,name,mime_type,artifact_type,content_text) VALUES($1::uuid,$2,$3,$1::text,'Reunión 2026/09/25','text/plain','document','')",[imported,connectionId,folderId]);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({items:[{id:'qa-calendar-event',attachments:[{fileId:imported}],organizer:{email:`${employeeId}@example.test`}}]}))));
    try {
      const linked=await request(server.app).post(`/api/meetings/${imported}/organizer/detect`).set('Authorization',authorization).send({});
      expect(linked.status).toBe(200);expect(linked.body.linked).toBe(true);
      expect((await server.pool.query('SELECT employee_id,assigned_by FROM meeting_artifact_organizers WHERE artifact_id=$1',[imported])).rows[0]).toEqual({employee_id:employeeId,assigned_by:'calendar:qa-calendar-event'});
      await request(server.app).put(`/api/meetings/${imported}/organizer`).set('Authorization',authorization).send({employee_id:employeeId});
      const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
      expect((await server.linkMeetingOrganizer(imported)).linked).toBe(true);expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await server.pool.query('UPDATE google_drive_connections SET scope=NULL WHERE id=$1',[connectionId]);
      await server.pool.query('DELETE FROM google_drive_artifacts WHERE id=$1',[imported]);
    }
  });

  it('P-06: altas locales de organigrama y escalado real sin aprobar', async () => {
    const positionId=`qa-local-role-${artifactId}`;
    const directorId=`qa-local-director-${artifactId}`;
    await server.pool.query("INSERT INTO empleados(id,numero,nombre) VALUES($1,$1,'Director de prueba')",[directorId]);
    await server.pool.query("INSERT INTO organigrama_cargos(id,nombre) VALUES($1,'Director General')",[positionId]);
    let localId='';
    try {
      const created=await request(server.app).post('/api/directory/organization/assignments').set('Authorization',authorization).send({cargo_id:positionId,empleado_id:directorId,proyecto_id:projectId});
      expect(created.status).toBe(201);localId=created.body.id;expect(localId).toMatch(/^local:/);
      expect((await request(server.app).post('/api/directory/organization/assignments').set('Authorization',authorization).send({cargo_id:positionId,empleado_id:directorId,proyecto_id:projectId})).status).toBe(409);
      await server.pool.query("UPDATE meeting_reviews SET workflow_stage='operations',status='pending',analysis_status='completed',project_id=$2 WHERE artifact_id=$1",[artifactId,projectId]);
      const escalation=await request(server.app).post(`/api/operations/escalations/${artifactId}`).set('Authorization',authorization).send({reason:'Revisión excepcional de QA'});
      expect(escalation.status).toBe(200);expect(escalation.body.stage).toBe('director');
      expect((await server.pool.query('SELECT status,manual_revision FROM meeting_reviews WHERE artifact_id=$1',[artifactId])).rows[0]).toEqual({status:'pending',manual_revision:true});
      expect((await request(server.app).post(`/api/operations/escalations/${artifactId}`).set('Authorization',authorization).send({reason:'No saltar el final'})).status).toBe(409);
      expect((await request(server.app).delete(`/api/directory/organization/assignments/${localId}`).set('Authorization',authorization)).status).toBe(200);
      expect((await request(server.app).delete('/api/directory/organization/assignments/original-supabase').set('Authorization',authorization)).status).toBe(409);
    } finally { await server.pool.query('DELETE FROM organigrama_cargos WHERE id=$1',[positionId]);await server.pool.query('DELETE FROM empleados WHERE id=$1',[directorId]);await server.pool.query("DELETE FROM dashboard_change_events WHERE entity_id=$1",[localId]); }
  });

  it('P-06: CRM persiste prospectos y su historial; incidencia resuelta deja evento', async () => {
    const leadId=randomUUID();const blockerId=randomUUID();
    try {
      const first=await request(server.app).put(`/api/crm/leads/${leadId}`).set('Authorization',authorization).send({name:'Prospecto QA',email:'qa@example.test',status:'new',notes:'Prueba local'});
      expect(first.status).toBe(200);
      expect((await request(server.app).put(`/api/crm/leads/${leadId}`).set('Authorization',authorization).send({...first.body,status:'qualified'})).status).toBe(200);
      expect((await request(server.app).get(`/api/operations/history/lead/${leadId}`).set('Authorization',authorization)).body).toHaveLength(2);
      await server.pool.query("INSERT INTO meeting_review_blockers(id,artifact_id,title) VALUES($1,$2,'Bloqueo QA')",[blockerId,artifactId]);
      expect((await request(server.app).put(`/api/operations/incidents/${blockerId}`).set('Authorization',authorization).send({resolved:true,note:'Solución validada por QA'})).status).toBe(200);
      expect((await request(server.app).get('/api/operations/incidents').set('Authorization',authorization)).body.find((item:{id:string})=>item.id===blockerId).resolved).toBe(true);
      const detail = await request(server.app).get(`/api/meetings/${artifactId}`).set('Authorization',authorization);
      expect(detail.status).toBe(200);
      expect(detail.body.detected_blockers.find((item:{id:string})=>item.id===blockerId)).toMatchObject({resolved:true,resolution_note:'Solución validada por QA'});
      const versions=await server.pool.query("SELECT detail FROM meeting_review_versions WHERE artifact_id=$1 AND detail LIKE 'Incidencia resuelta%'",[artifactId]);expect(versions.rows.length).toBeGreaterThan(0);
      for(const path of ['/api/crm/leads','/api/crm/identities','/api/directory/organization','/api/operations/escalations']) expect((await request(server.app).get(path).set('Authorization',authorization)).status).toBe(200);
    }finally{await server.pool.query('DELETE FROM crm_leads WHERE id=$1',[leadId]);await server.pool.query('DELETE FROM meeting_review_blockers WHERE id=$1',[blockerId]);await server.pool.query('DELETE FROM dashboard_change_events WHERE entity_id=ANY($1::text[])',[[leadId,blockerId]]);}
  });

  it('P-06: usuarios de reuniones no acceden a CRM ni a administración del organigrama',async()=>{
    const body=Buffer.from(JSON.stringify({id:userId,usuario:employeeId,rol:'employee:interiorista',exp:Date.now()+3600000})).toString('base64url');
    const auth=`Bearer ${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
    for(const path of ['/api/crm/leads','/api/crm/identities','/api/directory/organization','/api/operations/escalations','/api/operations/incidents']) expect((await request(server.app).get(path).set('Authorization',auth)).status).toBe(403);
    expect((await request(server.app).post('/api/directory/organization/assignments').set('Authorization',auth).send({})).status).toBe(403);
  });

  it('P-07: desconectar cuenta detiene sus carpetas sin borrar el histórico', async () => {
    const response = await request(server.app).delete(`/api/google-drive/connections/${connectionId}`).set('Authorization', authorization);
    expect(response.status).toBe(200);
    expect((await server.pool.query('SELECT enabled FROM google_drive_folders WHERE id = $1', [folderId])).rows[0].enabled).toBe(false);
    expect((await server.pool.query('SELECT id FROM google_drive_artifacts WHERE id = $1', [artifactId])).rowCount).toBe(1);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      expect((await request(server.app).post(`/api/google-drive/folders/${folderId}/sync`).set('Authorization', authorization).send({})).status).toBe(502);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('QA global: aísla cuentas de extensión y descuenta solo el chat resumido sin marcar WhatsApp', async () => {
    const accountIds = [`qa-account-a-${artifactId}`, `qa-account-b-${artifactId}`];
    const invitationId = randomUUID();
    const activationId = randomUUID();
    const rawChat = '120363000000000001@g.us';
    const otherChat = '120363000000000002@g.us';
    const chatIds = [`${accountIds[0]}::${rawChat}`, `${accountIds[1]}::${rawChat}`, `${accountIds[0]}::${otherChat}`];
    const fetcher = vi.fn().mockRejectedValue(new Error('No se permite contacto externo en este test'));
    vi.stubGlobal('fetch', fetcher);
    try {
      for (const account of accountIds) await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)',[account]);
      await server.pool.query("INSERT INTO extension_invitations(id,code_hash,expires_at,created_by,account_id) VALUES($1::uuid,$1::text,NOW()+INTERVAL '1 hour','qa',$2)",[invitationId,accountIds[0]]);
      await server.pool.query('INSERT INTO extension_activations(id,invitation_id,account_id) VALUES($1,$2,$3)',[activationId,invitationId,accountIds[0]]);
      for (const [index, chatId] of chatIds.entries()) {
        const account = index === 1 ? accountIds[1] : accountIds[0];
        await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'Grupo QA',1,1)",[chatId,account]);
        await server.pool.query("INSERT INTO grupos(id,account_id,nombre) VALUES($1,$2,'Grupo QA')",[chatId,account]);
        await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto) VALUES($1,$2,$3,'QA',$4)",[randomUUID(),chatId,account,`Mensaje privado ${index}`]);
      }
      const headers = {'x-extension-activation':activationId};
      const chats = await request(server.app).get('/api/chats').set(headers);
      expect(chats.status).toBe(200); expect(chats.body).toHaveLength(2);
      const messages = await request(server.app).get(`/api/chats/${encodeURIComponent(chatIds[1])}/mensajes`).set(headers);
      expect(messages.status).toBe(200);
      expect(messages.body.some((message:{texto:string})=>message.texto==='Mensaje privado 1')).toBe(false);
      generation.mockResolvedValue({text:'Resumen operativo QA',fallback:false,provider:'qa',model:'stub'});
      const summary = await request(server.app).post('/api/chat/summary').set(headers).send({chatId:rawChat,specialistId:'general'});
      expect(summary.status,JSON.stringify(summary.body)).toBe(200);
      expect(summary.body.summaryId).toBeTruthy();
      const counters = await server.pool.query('SELECT id,unread_count,whatsapp_unread_count FROM chats WHERE id=ANY($1::varchar[])',[chatIds]);
      for(const row of counters.rows) {
        expect(row.whatsapp_unread_count).toBe(1);
        expect(row.unread_count).toBe(row.id===chatIds[0]?0:1);
      }
      expect(fetcher).not.toHaveBeenCalled();
      await server.pool.query('UPDATE extension_activations SET revoked_at=NOW() WHERE id=$1',[activationId]);
      expect((await request(server.app).get('/api/chats').set(headers)).status).toBe(403);
    } finally {
      vi.unstubAllGlobals();
      await server.pool.query('DELETE FROM resumenes_chat WHERE account_id=ANY($1::varchar[])',[accountIds]);
      await server.pool.query('DELETE FROM grupos WHERE id=ANY($1::varchar[])',[chatIds]);
      await server.pool.query('DELETE FROM chats WHERE id=ANY($1::varchar[])',[chatIds]);
      await server.pool.query('DELETE FROM extension_activations WHERE id=$1',[activationId]);
      await server.pool.query('DELETE FROM extension_invitations WHERE id=$1',[invitationId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=ANY($1::varchar[])',[accountIds]);
    }
  });

  it('Q-01: cola durable, 1105 mensajes, deduplicación, aislamiento y recuperación tras reinicio', async () => {
    const accountId = `qa-queue-${randomUUID()}`;
    const rawChat = '120363999900001@g.us';
    const chatId = `${accountId}::${rawChat}`;
    const invitationId = randomUUID();
    const activationId = randomUUID();
    const headers = { 'x-extension-activation': activationId };
    let lock: Awaited<ReturnType<typeof acquireSummaryLock>> = null;
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      await server.pool.query("INSERT INTO extension_invitations(id,code_hash,expires_at,created_by,account_id) VALUES($1::uuid,$1::text,NOW()+INTERVAL '1 hour','qa',$2)", [invitationId,accountId]);
      await server.pool.query('INSERT INTO extension_activations(id,invitation_id,account_id) VALUES($1,$2,$3)', [activationId,invitationId,accountId]);
      await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'Grupo extenso',1105,1105)", [chatId,accountId]);
      await server.pool.query(`INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,timestamp,enviado_por_mi)
        SELECT $2 || ':' || sequence,$1,$2,'QA','Mensaje ' || sequence,NOW()-INTERVAL '2 hours'+sequence*INTERVAL '1 second',FALSE FROM generate_series(1,1105) sequence`, [chatId,accountId]);
      const submissions = await Promise.all([1,2].map(() => request(server.app).post('/api/chat/global-summary').set(headers).send({specialistId:'general'})));
      expect(submissions.map((response) => response.status)).toEqual([202,202]);
      const jobId = submissions[0].body.jobId;
      expect(submissions[1].body.jobId).toBe(jobId);
      lock = await acquireSummaryLock(server.pool,accountId);
      expect(lock).not.toBeNull();
      expect((await request(server.app).post('/api/chat/summary').set(headers).send({chatId:rawChat})).status).toBe(409);
      expect(await acquireSummaryLock(server.pool,accountId)).toBeNull();
      await releaseSummaryLock(lock!,accountId); lock=null;
      expect((await request(server.app).get(`/api/chat/global-summary/jobs/${jobId}`).set('Authorization',authorization)).status).toBe(404);
      expect((await request(server.app).get('/api/chat/global-summary/jobs/invalid').set(headers)).status).toBe(400);
      const crashedWorker=spawn(process.execPath,['--input-type=module','-e',`
        import pg from 'pg';
        const client=new pg.Client({connectionString:process.env.QA_TEST_DATABASE_URL});
        await client.connect();
        await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['summary:'+process.argv[1]]);
        await client.query("UPDATE summary_jobs SET status='running',attempts=1 WHERE id=$1",[process.argv[2]]);
        console.log('LOCKED');
        setInterval(()=>{},1000);
      `,accountId,jobId],{stdio:['ignore','pipe','pipe']});
      try {
        const ready=await once(crashedWorker.stdout!,'data',{signal:AbortSignal.timeout(5000)});
        expect(String(ready[0])).toContain('LOCKED');
      }finally{
        const stopped=once(crashedWorker,'exit');
        crashedWorker.kill();
        await stopped;
      }
      generation.mockImplementation(async (prompt: string) => evidenceResponse(prompt)).mockImplementationOnce(async (prompt: string) => {
        expect(prompt).toContain('Mensaje 1');
        await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,enviado_por_mi) VALUES($1,$2,$3,'QA','Llegó durante el análisis',FALSE)", [accountId+':new',chatId,accountId]);
        await server.pool.query('UPDATE chats SET whatsapp_unread_count=1106,unread_count=1106 WHERE id=$1', [chatId]);
        return evidenceResponse(prompt);
      });
      const restartedQueue = createSummaryQueue(server.pool,server.prepareGlobalSummary);
      await Promise.all([restartedQueue.run(),restartedQueue.run()]);
      const completed = await request(server.app).get(`/api/chat/global-summary/jobs/${jobId}`).set(headers);
      expect(completed.status).toBe(200);
      expect(completed.body).toMatchObject({status:'completed',en_progreso:false,mensajes_analizados:1105});
      expect((await server.pool.query('SELECT attempts FROM summary_jobs WHERE id=$1',[jobId])).rows[0].attempts).toBe(2);
      expect((await server.pool.query('SELECT unread_count,whatsapp_unread_count FROM chats WHERE id=$1',[chatId])).rows[0]).toEqual({unread_count:1,whatsapp_unread_count:1106});
      const context = await server.getUnreadMessageContext(rawChat,{id:accountId,nombre:'QA',activo:true,evolutionInstanceName:accountId},{unlimited:true});
      expect(context.rows.map((message) => message.texto)).toEqual(['Llegó durante el análisis']);
      expect((await request(server.app).get('/api/chat/global-summaries/latest?specialistId=general').set(headers)).body.jobId).toBe(jobId);
      const summaryCount = await server.pool.query('SELECT COUNT(*)::integer AS total FROM resumenes_globales_chat WHERE account_id=$1',[accountId]);
      expect(summaryCount.rows[0].total).toBe(1);
      lock=await acquireSummaryLock(server.pool,accountId);
      await lock!.query('BEGIN');
      expect(await markSummaryMessagesReviewed(lock!,accountId,[chatId],[accountId+':1105'])).toBe(1);
      await lock!.query('COMMIT');
      await releaseSummaryLock(lock!,accountId);lock=null;
      generation.mockResolvedValueOnce({text:'',fallback:true,provider:'qa',model:'stub'});
      const failedJob=await restartedQueue.enqueue(accountId,'general');
      await restartedQueue.run();
      expect((await request(server.app).get(`/api/chat/global-summary/jobs/${failedJob.id}`).set(headers)).body).toMatchObject({status:'failed',en_progreso:false});
      expect((await server.pool.query('SELECT unread_count FROM chats WHERE id=$1',[chatId])).rows[0].unread_count).toBe(1);
    } finally {
      if(lock) await releaseSummaryLock(lock,accountId);
      generation.mockReset();
      await server.pool.query('DELETE FROM summary_reviewed_messages WHERE account_id=$1',[accountId]);
      await server.pool.query('DELETE FROM resumenes_globales_chat WHERE account_id=$1',[accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1',[accountId]);
      await server.pool.query('DELETE FROM extension_activations WHERE id=$1',[activationId]);
      await server.pool.query('DELETE FROM extension_invitations WHERE id=$1',[invitationId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1',[accountId]);
    }
  },60000);

  it('la síntesis conserva hallazgos verificados sin publicar una reformulación rechazada ni omitir mensajes', async () => {
    const accountId = `qa-synthesis-${randomUUID()}`;
    const chatId = `${accountId}::120363999930000@g.us`;
    const specialistId = `qa-role-${randomUUID()}`;
    const role = 'Agrupa por obra. Omite saludos, apartados vacíos y asuntos ajenos a obras. No cierres un problema solo por haberlo comentado.';
    generation.mockReset().mockImplementation(async (prompt: string, _model: string, system: string) => {
      expect(prompt).toContain(JSON.stringify(role));
      expect(system).toMatch(/PROMPT_DEL_ROL|Agrupa por obra/);
      const data = evidencePayload(prompt);
      if (data.draft) return { ...evidenceResponse(prompt), text: JSON.stringify({ approved: false, issues: ['La fuga no está resuelta'] }) };
      if (data.sources) {
        const response = evidenceResponse(prompt);
        const draft = JSON.parse(response.text);
        draft.entries.forEach((entry: { text: string }) => { entry.text = 'Obra Dana: fuga reparada y cerrada.'; });
        return { ...response, text: JSON.stringify(draft) };
      }
      if (!data.sources && !data.analysis) return { ...evidenceResponse(prompt), text: JSON.stringify({ findings: [{
        kind: 'blocker', state: 'pending', topicRef: null, text: 'Obra Dana: sigue la fuga sin reparar.',
        evidence: [{ source: data.primary[0].ref, quote: 'Obra Dana: sigue la fuga sin reparar.' }],
      }], informational: [] }) };
      return evidenceResponse(prompt);
    });
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      await server.pool.query("INSERT INTO especialistas(id,nombre,rol,sistema_prompt,modelo) VALUES($1,'QA síntesis','general',$2,'flash')", [specialistId, role]);
      await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'Obra Dana',1,1)", [chatId, accountId]);
      await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,timestamp,tipo,enviado_por_mi) VALUES($1,$2,$3,'Laura','Obra Dana: sigue la fuga sin reparar.','2026-09-29T10:00:00Z','text',FALSE)", [`${accountId}:1`, chatId, accountId]);
      const queue = createSummaryQueue(server.pool, server.prepareGlobalSummary);
      const job = await queue.enqueue(accountId, specialistId);
      await queue.run();
      await queue.run();
      const state = (await server.pool.query('SELECT status,error FROM summary_jobs WHERE id=$1', [job.id])).rows[0];
      expect(state.status, state.error).toBe('completed');
      for (const table of ['resumenes_globales_chat', 'summary_reviewed_messages']) expect((await server.pool.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE account_id=$1`, [accountId])).rows[0].count).toBe(1);
      expect((await server.pool.query('SELECT * FROM summary_skipped_messages WHERE account_id=$1', [accountId])).rowCount).toBe(0);
      const report = (await server.pool.query('SELECT resumen,evidence FROM resumenes_globales_chat WHERE account_id=$1', [accountId])).rows[0];
      expect(report.resumen).toContain('Obra Dana: sigue la fuga sin reparar.');
      expect(report.resumen).toContain('Asuntos verificados pendientes de agrupar');
      expect(report.resumen).not.toContain('fuga reparada y cerrada');
      expect(report.resumen).not.toContain('HALLAZGOS Y SECUENCIA');
      expect(report.evidence.synthesis.rolePrompt).toBe(role);
      expect(report.evidence.synthesis.entries[0].sources).toEqual(['G1-F1']);
      expect(report.evidence.synthesis.recoveries.map((item: { mode: string }) => item.mode)).toEqual(['detail', 'overview']);
      expect(report.evidence.groups[0].sources[0].line).toContain('2026-09-29T10:00:00.000Z');
      expect((await server.pool.query('SELECT unread_count FROM chats WHERE id=$1', [chatId])).rows[0].unread_count).toBe(0);
    } finally {
      generation.mockReset();
      await server.pool.query('DELETE FROM resumenes_globales_chat WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
      await server.pool.query('DELETE FROM especialistas WHERE id=$1', [specialistId]);
    }
  });

  it.each([300, 20000, 50000])('Q-volumen %i: lotes durables, fallo parcial y reanudación sin consumir mensajes nuevos', async (totalMessages) => {
    const accountId = `qa-volume-${totalMessages}-${randomUUID()}`;
    const chatId = `${accountId}::120363999920000@g.us`;
    const accepted: string[] = [];
    const fetcher = vi.fn().mockRejectedValue(new Error('Esta prueba no permite red'));
    vi.stubGlobal('fetch', fetcher);
    generation.mockReset();
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'Grupo QA volumen',$3,$3)", [chatId, accountId, totalMessages]);
      await server.pool.query(`INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,timestamp,enviado_por_mi)
        SELECT $2 || ':' || sequence,$1,$2,'QA','MSG' || lpad(sequence::text,5,'0') || ' Confirmar planos. ' || repeat('Texto sintético. ',10),
        NOW()-INTERVAL '1 day'+sequence*INTERVAL '1 second',FALSE FROM generate_series(1,$3::integer) sequence`, [chatId, accountId, totalMessages]);
      let calls = 0;
      generation.mockImplementation(async (prompt: string) => {
        calls++;
        if (calls === 3) throw new Error('Interrupción sintética del proveedor');
        expect(prompt.length).toBeLessThan(50000);
        if (prompt.startsWith('ETAPA: EXTRACCION')) accepted.push(...evidencePayload(prompt).primary.flatMap((source: { line: string }) => source.line.match(/MSG\d{5}/g) || []));
        return evidenceResponse(prompt);
      });
      const queue = createSummaryQueue(server.pool, server.prepareGlobalSummary);
      const job = await queue.enqueue(accountId, 'general');
      await queue.run();
      expect((await server.pool.query('SELECT status FROM summary_jobs WHERE id=$1', [job.id])).rows[0].status).toBe('failed');
      const storedProgress = (await server.pool.query('SELECT result FROM summary_jobs WHERE id=$1', [job.id])).rows[0].result.progress;
      expect(storedProgress).toMatchObject({ completedMessages: accepted.length, totalMessages });
      expect(storedProgress.completedMessages).toBeGreaterThan(0);
      expect((await server.pool.query('SELECT COUNT(*)::int AS total FROM summary_job_batches WHERE job_id=$1', [job.id])).rows[0].total).toBe(2);
      expect((await server.pool.query('SELECT unread_count FROM chats WHERE id=$1', [chatId])).rows[0].unread_count).toBe(totalMessages);
      expect((await server.pool.query('SELECT * FROM summary_reviewed_messages WHERE account_id=$1', [accountId])).rowCount).toBe(0);
      expect((await server.pool.query('SELECT * FROM resumenes_globales_chat WHERE account_id=$1', [accountId])).rowCount).toBe(0);
      await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,enviado_por_mi) VALUES($1,$2,$3,'QA','Mensaje posterior al inicio',FALSE)", [`${accountId}:new`, chatId, accountId]);
      await server.pool.query('UPDATE chats SET whatsapp_unread_count=$2,unread_count=$2 WHERE id=$1', [chatId, totalMessages + 1]);
      const restarted = createSummaryQueue(server.pool, server.prepareGlobalSummary);
      const submissions = await Promise.all([restarted.enqueue(accountId, 'general'), restarted.enqueue(accountId, 'general')]);
      expect(submissions.map((submitted) => submitted.id)).toEqual([job.id, job.id]);
      await restarted.run();
      const saved = (await server.pool.query('SELECT status,result FROM summary_jobs WHERE id=$1', [job.id])).rows[0];
      expect(saved.status).toBe('completed');
      expect(saved.result).toMatchObject({ mensajes_analizados: totalMessages, mensajes_pendientes_restantes: 1 });
      expect(accepted).toHaveLength(totalMessages);
      expect(new Set(accepted).size).toBe(totalMessages);
      expect((await server.pool.query('SELECT COUNT(*)::int AS total FROM summary_reviewed_messages WHERE account_id=$1', [accountId])).rows[0].total).toBe(totalMessages);
      expect((await server.pool.query('SELECT unread_count,whatsapp_unread_count FROM chats WHERE id=$1', [chatId])).rows[0]).toEqual({ unread_count: 1, whatsapp_unread_count: totalMessages + 1 });
      expect((await server.pool.query('SELECT * FROM summary_job_contexts WHERE job_id=$1', [job.id])).rowCount).toBe(0);
      expect((await server.pool.query('SELECT * FROM summary_job_batches WHERE job_id=$1', [job.id])).rowCount).toBe(0);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      generation.mockReset();
      await server.pool.query('DELETE FROM resumenes_globales_chat WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM summary_reviewed_messages WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  }, 300000);

  it('contador, lista e informe coinciden: solo textos disponibles no analizados, incluso con cero no leídos', async () => {
    const accountId = `qa-available-${randomUUID()}`;
    const invitationId = randomUUID();
    const activationId = randomUUID();
    const headers = { 'x-extension-activation': activationId };
    const chatIds = ['120363999900021@g.us', '120363999900022@g.us', '120363999900023@g.us'].map((id) => `${accountId}::${id}`);
    const fetcher = vi.fn().mockRejectedValue(new Error('Sin red para seleccionar mensajes disponibles'));
    vi.stubGlobal('fetch', fetcher);
    generation.mockReset().mockImplementation(async (prompt: string) => evidenceResponse(prompt));
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      await server.pool.query("INSERT INTO extension_invitations(id,code_hash,expires_at,created_by,account_id) VALUES($1::uuid,$1::text,NOW()+INTERVAL '1 hour','qa',$2)", [invitationId, accountId]);
      await server.pool.query('INSERT INTO extension_activations(id,invitation_id,account_id) VALUES($1,$2,$3)', [activationId, invitationId, accountId]);
      for (const [index, chatId] of chatIds.entries()) await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'Disponible QA',$3,$3)", [chatId, accountId, index === 2 ? 0 : 10000]);
      const fixtures = [
        { id: 'text', chat: 0, text: 'Revisar planos', tipo: 'text', raw: {} },
        { id: 'raw-text', chat: 0, text: '', tipo: 'text', raw: { message: { conversation: 'Confirmar fecha' } } },
        { id: 'already-read', chat: 2, text: 'Aprobar presupuesto', tipo: 'text', raw: {} },
        { id: 'reviewed', chat: 0, text: 'Ya analizado', tipo: 'text', raw: {} },
        { id: 'empty', chat: 0, text: ' \n\t ', tipo: 'text', raw: {} },
        { id: 'audio', chat: 0, text: '', tipo: 'audio', raw: {} },
        { id: 'image-caption', chat: 0, text: 'Adjunto no analizable', tipo: 'text', raw: { message: { imageMessage: { caption: 'Adjunto no analizable' } } } },
        { id: 'outgoing', chat: 0, text: 'No resumir salida', tipo: 'text', raw: {} },
        { id: 'dashboard', chat: 0, text: 'No resumir entrada interna', tipo: 'text', raw: {} },
      ];
      for (const fixture of fixtures) await server.pool.query('INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,tipo,raw,enviado_por_mi,source) VALUES($1,$2,$3,$3,$4,$5,$6::jsonb,$7,$8)', [`${accountId}:${fixture.id}`, chatIds[fixture.chat], accountId, fixture.text, fixture.tipo, JSON.stringify(fixture.raw), fixture.id === 'outgoing', fixture.id === 'dashboard' ? 'dashboard' : 'evolution']);
      await server.pool.query('INSERT INTO summary_reviewed_messages(account_id,message_id) VALUES($1,$2)', [accountId, `${accountId}:reviewed`]);
      const chats = await request(server.app).get('/api/chats').set(headers);
      expect(chats.status).toBe(200);
      expect(chats.body.map((chat) => chat.unread_count).sort()).toEqual([0, 1, 2]);
      const pending = await request(server.app).get('/api/pendientes').set(headers);
      expect(pending.status).toBe(200);
      expect(pending.body.map((chat) => chat.unread_count).sort()).toEqual([1, 2]);
      expect(pending.body.every((chat) => chat.texto.trim() && !chat.raw)).toBe(true);
      const job = await createSummaryQueue(server.pool, server.prepareGlobalSummary).enqueue(accountId, 'general');
      await createSummaryQueue(server.pool, server.prepareGlobalSummary).run();
      const saved = (await server.pool.query('SELECT status,result,error FROM summary_jobs WHERE id=$1', [job.id])).rows[0];
      expect(saved.status, saved.error).toBe('completed');
      expect(saved.result).toMatchObject({ mensajes_pendientes: 3, mensajes_analizados: 3, mensajes_pendientes_restantes: 0 });
      const report = (await server.pool.query('SELECT mensaje_ids FROM resumenes_globales_chat WHERE account_id=$1', [accountId])).rows[0];
      expect(report.mensaje_ids.sort()).toEqual(['text', 'raw-text', 'already-read'].map((id) => `${accountId}:${id}`).sort());
      expect((await request(server.app).get('/api/chats').set(headers)).body.every((chat) => chat.unread_count === 0)).toBe(true);
      expect((await request(server.app).get('/api/pendientes').set(headers)).body).toEqual([]);
      expect(fetcher).not.toHaveBeenCalled();
      expect((await server.pool.query('SELECT id FROM mensajes WHERE account_id=$1', [accountId])).rowCount).toBe(fixtures.length);
    } finally {
      vi.unstubAllGlobals();
      generation.mockReset();
      await server.pool.query('DELETE FROM resumenes_globales_chat WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM summary_reviewed_messages WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM extension_activations WHERE id=$1', [activationId]);
      await server.pool.query('DELETE FROM extension_invitations WHERE id=$1', [invitationId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it.each([0, 5, 10000])('el informe no espera historial aunque WhatsApp indique %s pendientes', async (pending) => {
    const accountId = `qa-history-${randomUUID()}`;
    const chatId = `${accountId}::120363999900003@g.us`;
    const fetcher = vi.fn().mockRejectedValue(new Error('El informe no debe consultar Evolution'));
    vi.stubGlobal('fetch', fetcher);
    generation.mockReset().mockImplementation(async (prompt: string) => evidenceResponse(prompt));
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'QA',$3,$3)", [chatId, accountId, pending]);
      await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,enviado_por_mi) VALUES($1,$2,$1,'QA','Único texto disponible',FALSE)", [accountId, chatId]);
      const queue = createSummaryQueue(server.pool, server.prepareGlobalSummary);
      const job = await queue.enqueue(accountId, 'general');
      await queue.run();
      const saved = (await server.pool.query('SELECT status,result,error FROM summary_jobs WHERE id=$1', [job.id])).rows[0];
      expect(saved.status, saved.error).toBe('completed');
      expect(saved.result).toMatchObject({ mensajes_analizados: 1, mensajes_pendientes: 1, mensajes_pendientes_restantes: 0,
        coverage: { scope: 'available_texts', pending: 1, texts: 1 } });
      expect(fetcher).not.toHaveBeenCalled();
      expect((await server.pool.query('SELECT whatsapp_unread_count FROM chats WHERE id=$1', [chatId])).rows[0].whatsapp_unread_count).toBe(pending);
      expect((await server.pool.query('SELECT message_id FROM summary_reviewed_messages WHERE account_id=$1', [accountId])).rows).toEqual([{ message_id: accountId }]);
      const next = await queue.enqueue(accountId, 'general');
      await queue.run();
      expect((await server.pool.query('SELECT error FROM summary_jobs WHERE id=$1', [next.id])).rows[0].error).toContain('No hay textos disponibles');
      expect((await server.pool.query('SELECT id FROM resumenes_globales_chat WHERE account_id=$1', [accountId])).rowCount).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      generation.mockReset();
      await server.pool.query('DELETE FROM resumenes_globales_chat WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM summary_reviewed_messages WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it('incluye los 3000 textos de todos los grupos, no reutiliza una selección antigua parcial y deja adjuntos y nuevas llegadas pendientes', async () => {
    const accountId = `qa-all-text-${randomUUID()}`;
    const chatIds = [1, 2, 3].map((group) => `${accountId}::120363999900004${group}@g.us`);
    const fetcher = vi.fn().mockRejectedValue(new Error('No debe solicitar red con todo el historial disponible'));
    const selectedIds: string[] = [];
    let arrived = false;
    vi.stubGlobal('fetch', fetcher);
    generation.mockReset().mockImplementation(async (prompt: string) => {
      if (prompt.startsWith('ETAPA: EXTRACCION')) selectedIds.push(...evidencePayload(prompt).primary.flatMap((source: { line: string }) => source.line.match(/TEXT-\d+-\d+/g) || []));
      if (!arrived) {
        arrived = true;
        await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,enviado_por_mi) VALUES($1,$2,$3,'QA','Llegada posterior',FALSE)", [`${accountId}:new`, chatIds[0], accountId]);
        await server.pool.query('UPDATE chats SET whatsapp_unread_count=whatsapp_unread_count+1,unread_count=unread_count+1 WHERE id=$1', [chatIds[0]]);
      }
      return evidenceResponse(prompt);
    });
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      for (const [index, chatId] of chatIds.entries()) {
        const media = index === 2 ? 11 : 12;
        await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count,reviewed_unread_baseline) VALUES($1,$2,$3,$4,$4+48,48)", [chatId, accountId, `Grupo QA ${index}`, 1000 + media]);
        await server.pool.query(`INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,timestamp,enviado_por_mi)
          SELECT $1 || ':text-' || sequence,$1,$2,'QA','TEXT-' || $3::text || '-' || sequence,
          NOW()-INTERVAL '2 hours'+sequence*INTERVAL '1 second',FALSE FROM generate_series(1,1048) sequence`, [chatId, accountId, index]);
        await server.pool.query(`INSERT INTO summary_reviewed_messages(account_id,message_id)
          SELECT $1,$2 || ':text-' || sequence FROM generate_series(1,48) sequence`, [accountId, chatId]);
        await server.pool.query(`INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,tipo,enviado_por_mi)
          SELECT $1 || ':media-' || sequence,$1,$2,'QA','','audio',FALSE FROM generate_series(1,$3::int) sequence`, [chatId, accountId, media]);
      }
      const queue = createSummaryQueue(server.pool, server.prepareGlobalSummary);
      const job = await queue.enqueue(accountId, 'general');
      await server.pool.query('INSERT INTO summary_job_contexts(job_id,snapshot) VALUES($1,$2::jsonb)', [job.id, JSON.stringify({ selected: [], totalPending: 3035, groupCount: 3 })]);
      await server.pool.query("INSERT INTO summary_job_batches(job_id,cache_key,result) VALUES($1,'legacy',$2::jsonb)", [job.id, JSON.stringify({ text: 'Parcial antiguo' })]);
      await queue.run();
      const saved = (await server.pool.query('SELECT status,result,error FROM summary_jobs WHERE id=$1', [job.id])).rows[0];
      expect(saved.status, saved.error).toBe('completed');
      expect(saved.result).toMatchObject({ grupos_analizados: 3, mensajes_analizados: 3000, mensajes_pendientes: 3000,
        mensajes_pendientes_restantes: 1, coverage: { scope: 'available_texts', pending: 3000, texts: 3000 } });
      expect(selectedIds).toHaveLength(3000);
      expect(new Set(selectedIds).size).toBe(3000);
      for (const group of [0, 1, 2]) for (let sequence = 49; sequence <= 1048; sequence++) expect(selectedIds).toContain(`TEXT-${group}-${sequence}`);
      const reports = await server.pool.query('SELECT mensaje_ids FROM resumenes_globales_chat WHERE account_id=$1', [accountId]);
      expect(reports.rows).toHaveLength(1);
      expect(reports.rows[0].mensaje_ids).toHaveLength(3000);
      expect(reports.rows[0].mensaje_ids).not.toContain(`${accountId}:new`);
      expect((await server.pool.query('SELECT COUNT(*)::int AS total FROM summary_reviewed_messages WHERE account_id=$1', [accountId])).rows[0].total).toBe(3144);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      generation.mockReset();
      await server.pool.query('DELETE FROM resumenes_globales_chat WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM summary_reviewed_messages WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  }, 60000);

  it('Q-SINTESIS: conserva diagnósticos privados, reanuda tras rechazo y guarda exactamente una vez', async () => {
    const accountId = `qa-synthesis-${randomUUID()}`;
    const chatId = `${accountId}::120363999900091@g.us`;
    const text = 'Obra Dana: falta confirmar el material.';
    let reject = true;
    generation.mockReset().mockImplementation(async (prompt: string) => {
      const data = evidencePayload(prompt);
      const response = evidenceResponse(prompt);
      if (reject && data.mode === 'describe' && data.draft) return { ...response, text: JSON.stringify({ approved: false, issues: ['El responsable no está confirmado'] }) };
      return response;
    });
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'Obra Dana',1,1)", [chatId, accountId]);
      await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,enviado_por_mi) VALUES($1,$2,$1,'QA',$3,FALSE)", [accountId, chatId, text]);
      const queue = createSummaryQueue(server.pool, server.prepareGlobalSummary);
      const job = await queue.enqueue(accountId, 'general');
      await queue.run();
      const failed = (await server.pool.query('SELECT * FROM summary_jobs WHERE id=$1', [job.id])).rows[0];
      expect(failed.status).toBe('failed');
      expect(failed.result.synthesisDiagnostic).toMatchObject({ mode: 'describe', sources: ['G1-M1'], reason: expect.stringContaining('responsable no está confirmado') });
      expect(publicSummaryJob(failed)).not.toHaveProperty('synthesisDiagnostic');
      expect(failed.result.progress).toMatchObject({ stage: 'consolidating', completedMessages: 1 });
      expect((await server.pool.query('SELECT unread_count FROM chats WHERE id=$1', [chatId])).rows[0].unread_count).toBe(1);
      expect((await server.pool.query('SELECT * FROM summary_reviewed_messages WHERE account_id=$1', [accountId])).rowCount).toBe(0);
      expect((await server.pool.query('SELECT * FROM resumenes_globales_chat WHERE account_id=$1', [accountId])).rowCount).toBe(0);
      expect((await server.pool.query('SELECT * FROM summary_job_contexts WHERE job_id=$1', [job.id])).rowCount).toBe(1);
      reject = false;
      generation.mockClear();
      const resumed = createSummaryQueue(server.pool, server.prepareGlobalSummary);
      expect((await resumed.enqueue(accountId, 'general')).id).toBe(job.id);
      await resumed.run();
      await resumed.run();
      expect(generation.mock.calls.some(([prompt]) => /^ETAPA: (EXTRACCION|VERIFICACION)/.test(prompt))).toBe(false);
      const completed = (await server.pool.query('SELECT * FROM summary_jobs WHERE id=$1', [job.id])).rows[0];
      expect(completed.status).toBe('completed');
      expect(completed.result.resumen).toContain(text);
      expect(completed.result).not.toHaveProperty('synthesisDiagnostic');
      expect((await server.pool.query('SELECT * FROM resumenes_globales_chat WHERE account_id=$1', [accountId])).rowCount).toBe(1);
      expect((await server.pool.query('SELECT * FROM summary_reviewed_messages WHERE account_id=$1', [accountId])).rowCount).toBe(1);
      expect((await server.pool.query('SELECT unread_count FROM chats WHERE id=$1', [chatId])).rows[0].unread_count).toBe(0);
      expect((await server.pool.query('SELECT * FROM summary_job_batches WHERE job_id=$1', [job.id])).rowCount).toBe(0);
    } finally {
      generation.mockReset();
      await server.pool.query('DELETE FROM resumenes_globales_chat WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it('Q-02: fallo transaccional no consume mensajes ni guarda un informe incompleto', async () => {
    const accountId=`qa-rollback-${randomUUID()}`;
    const chatId=`${accountId}::120363999900002@g.us`;
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)',[accountId]);
      await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'QA',1,1)",[chatId,accountId]);
      await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,enviado_por_mi) VALUES($1,$2,$1,'QA','Pendiente',FALSE)",[accountId,chatId]);
      const queue=createSummaryQueue(server.pool,async()=>async(client)=>{
        await markSummaryMessagesReviewed(client,accountId,[chatId],[accountId]);
        throw new Error('Fallo SQL simulado');
      });
      const job=await queue.enqueue(accountId,'general');
      await queue.run();
      expect((await server.pool.query('SELECT status FROM summary_jobs WHERE id=$1',[job.id])).rows[0].status).toBe('failed');
      expect((await server.pool.query('SELECT unread_count FROM chats WHERE id=$1',[chatId])).rows[0].unread_count).toBe(1);
      expect((await server.pool.query('SELECT * FROM summary_reviewed_messages WHERE account_id=$1',[accountId])).rowCount).toBe(0);
    }finally {
      await server.pool.query('DELETE FROM summary_reviewed_messages WHERE account_id=$1',[accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1',[accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1',[accountId]);
    }
  });

  it('Q-06: el global analiza solo texto y no descarga ni descuenta adjuntos', async () => {
    const accountId = `qa-global-media-${randomUUID()}`;
    const chatIds = [1, 2].map((index) => `${accountId}::120363999900006${index}@g.us`);
    const ids = ['text', 'audio', 'missing'].map((suffix) => `${accountId}-${suffix}`);
    const fetcher = vi.fn().mockRejectedValue(new Error('No se permite red en esta regresión'));
    vi.stubGlobal('fetch', fetcher);
    mediaGeneration.mockReset();
    generation.mockReset().mockResolvedValueOnce({ text: '', fallback: true, provider: 'local-fallback', model: 'stub' });
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      for (const [index, chatId] of chatIds.entries()) await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,$3,$4,$4)", [chatId, accountId, `Grupo QA ${index + 1}`, index + 1]);
      await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,enviado_por_mi) VALUES($1,$2,$3,'QA','Revisar planos',FALSE)", [ids[0], chatIds[0], accountId]);
      await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,tipo,media,enviado_por_mi) VALUES($1,$2,$3,'QA','','audio',$4::jsonb,FALSE)", [ids[1], chatIds[1], accountId, JSON.stringify({ base64: 'cWE=', mimetype: 'audio/ogg' })]);
      await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,tipo,enviado_por_mi) VALUES($1,$2,$3,'QA','','video',FALSE)", [ids[2], chatIds[1], accountId]);
      const queue = createSummaryQueue(server.pool, server.prepareGlobalSummary);
      const failed = await queue.enqueue(accountId, 'general');
      await queue.run();
      expect((await server.pool.query('SELECT status FROM summary_jobs WHERE id=$1', [failed.id])).rows[0].status).toBe('failed');
      expect((await server.pool.query('SELECT SUM(unread_count)::int AS total FROM chats WHERE account_id=$1', [accountId])).rows[0].total).toBe(3);
      generation.mockImplementation(async (prompt: string) => evidenceResponse(prompt));
      const completed = await queue.enqueue(accountId, 'general');
      await queue.run();
      const saved = (await server.pool.query('SELECT status,result FROM summary_jobs WHERE id=$1', [completed.id])).rows[0];
      expect(saved.status).toBe('completed');
      expect(saved.result).toMatchObject({ grupos_analizados: 1, grupos_restantes: 0, mensajes_analizados: 1, mensajes_pendientes_restantes: 0 });
      expect(generation.mock.calls[1][0]).toContain('Revisar planos');
      expect(generation.mock.calls[1][0]).not.toContain('Grupo QA 2');
      expect(mediaGeneration).not.toHaveBeenCalled();
      const reviewed = await server.pool.query('SELECT message_id FROM summary_reviewed_messages WHERE account_id=$1', [accountId]);
      expect(reviewed.rows.map((row) => row.message_id)).toEqual([ids[0]]);
      const report = (await server.pool.query('SELECT resumen,evidence FROM resumenes_globales_chat WHERE account_id=$1', [accountId])).rows[0];
      expect(report.resumen).toContain('REPORTE DEL CONTENIDO ANALIZADO');
      expect(report.evidence.synthesis.kind).toBe('descriptive');
      expect(report.evidence.groups[0].sources.map((source: { messageId: string }) => source.messageId)).toEqual([ids[0]]);
      const callsBeforeMediaOnly = generation.mock.calls.length;
      expect(callsBeforeMediaOnly).toBe(7);
      const mediaOnly = await queue.enqueue(accountId, 'general');
      await queue.run();
      expect((await server.pool.query('SELECT status FROM summary_jobs WHERE id=$1', [mediaOnly.id])).rows[0].status).toBe('failed');
      expect(generation).toHaveBeenCalledTimes(callsBeforeMediaOnly);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await server.pool.query('DELETE FROM resumenes_globales_chat WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM summary_reviewed_messages WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it.each(['empty', 'recovered', 'offline'])('usa texto disponible sin consultar Evolution ni borrar registros (%s)', async (scenario) => {
    const recoverable = scenario === 'recovered';
    const accountId = `qa-empty-repair-${randomUUID()}`;
    const remoteJid = '120363999900012@g.us';
    const chatId = `${accountId}::${remoteJid}`;
    const knownText = 'Texto anterior que no debe borrarse';
    const repairedText = 'Texto pendiente recuperado de Evolution';
    const knownRaw = { message: { conversation: knownText }, messageType: 'conversation' };
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      expect(url).toContain(`/chat/findMessages/${accountId}`);
      if (scenario === 'offline') throw new Error('Evolution no disponible');
      const { page, where } = JSON.parse(String(options.body));
      expect(where.key).toEqual({ remoteJid, remoteJidAlt: remoteJid });
      const record = {
        key: { id: page === 1 ? 'known' : 'empty', remoteJid, fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000), messageType: 'conversation',
        message: page === 2 && recoverable ? { conversation: repairedText } : {},
      };
      const records = page === 1 ? [record, { ...record, key: { ...record.key, id: 'sticker' } }] : [record];
      return new Response(JSON.stringify({ messages: { pages: 2, currentPage: page, records } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    generation.mockReset().mockImplementation(async (prompt: string) => evidenceResponse(prompt));
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'Reparación QA',3,3)", [chatId, accountId]);
      for (const [id, text, raw] of [
        ['known', knownText, knownRaw],
        ['empty', '', { messageType: 'conversation', message: {} }],
        ['sticker', '', { messageType: 'lottieStickerMessage', message: { lottieStickerMessage: {} } }],
      ] as const) await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,tipo,raw,enviado_por_mi) VALUES($1,$2,$3,'QA',$4,'text',$5::jsonb,FALSE)", [`${accountId}::${id}`, chatId, accountId, text, JSON.stringify(raw)]);
      if (recoverable) await server.pool.query('UPDATE mensajes SET raw=$2::jsonb WHERE id=$1', [`${accountId}::empty`, JSON.stringify({ message: { conversation: repairedText } })]);
      const queue = createSummaryQueue(server.pool, server.prepareGlobalSummary);
      const job = await queue.enqueue(accountId, 'general');
      await queue.run();
      const saved = (await server.pool.query('SELECT status,result,error FROM summary_jobs WHERE id=$1', [job.id])).rows[0];
      expect(fetcher).not.toHaveBeenCalled();
      expect(saved.status, saved.error).toBe('completed');
      const known = (await server.pool.query('SELECT texto,tipo,raw FROM mensajes WHERE id=$1', [`${accountId}::known`])).rows[0];
      expect(known).toEqual({ texto: knownText, tipo: 'text', raw: knownRaw });
      expect(saved.result.coverage).toMatchObject({ scope: 'available_texts', pending: recoverable ? 2 : 1, texts: recoverable ? 2 : 1 });
      const reviewed = (await server.pool.query('SELECT message_id FROM summary_reviewed_messages WHERE account_id=$1', [accountId])).rows.map((row) => row.message_id);
      expect(reviewed).toHaveLength(recoverable ? 2 : 1);
      expect(reviewed).not.toContain(`${accountId}::sticker`);
      expect((await server.pool.query('SELECT unread_count,whatsapp_unread_count FROM chats WHERE id=$1', [chatId])).rows[0]).toEqual({ unread_count: recoverable ? 1 : 2, whatsapp_unread_count: 3 });
      expect((await server.pool.query('SELECT id FROM mensajes WHERE account_id=$1', [accountId])).rowCount).toBe(3);
      if (!recoverable) {
        expect(reviewed).not.toContain(`${accountId}::empty`);
        expect((await server.pool.query('SELECT texto FROM mensajes WHERE id=$1', [`${accountId}::empty`])).rows[0].texto).toBe('');
      }
    } finally {
      vi.unstubAllGlobals();
      generation.mockReset();
      await server.pool.query('DELETE FROM resumenes_globales_chat WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM summary_reviewed_messages WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM grupos WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it.each([{ empty: 246, texts: 2 }, { empty: 55, texts: 2 }, { empty: 3, texts: 0 }])('excluye $empty vacíos y analiza $texts textos sin eliminar registros', async ({ empty, texts }) => {
    const accountId = `qa-empty-volume-${randomUUID()}`;
    const chatId = `${accountId}::120363999900015@g.us`;
    const invitationId = randomUUID();
    const activationId = randomUUID();
    const headers = { 'x-extension-activation': activationId };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: { pages: 0, records: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    generation.mockReset().mockImplementation(async (prompt: string) => evidenceResponse(prompt));
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'Vacíos QA',$3,$3)", [chatId, accountId, empty + texts]);
      await server.pool.query("INSERT INTO grupos(id,account_id,nombre) VALUES($1,$2,'Vacíos QA')", [chatId, accountId]);
      await server.pool.query("INSERT INTO extension_invitations(id,code_hash,expires_at,created_by,account_id) VALUES($1::uuid,$1::text,NOW()+INTERVAL '1 hour','qa',$2)", [invitationId, accountId]);
      await server.pool.query('INSERT INTO extension_activations(id,invitation_id,account_id) VALUES($1,$2,$3)', [activationId, invitationId, accountId]);
      await server.pool.query(`INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,tipo,enviado_por_mi)
        SELECT $2 || ':' || sequence,$1,$2,'QA',CASE WHEN sequence <= $3 THEN CASE WHEN sequence % 2 = 0 THEN '' ELSE '   ' END ELSE 'Confirmar planos ' || sequence END,'text',FALSE
        FROM generate_series(1,$4::integer) sequence`, [chatId, accountId, empty, empty + texts]);
      for (let refresh = 0; refresh < 2; refresh++) {
        const chats = await request(server.app).get('/api/chats').set(headers);
        expect(chats.status).toBe(200);
        expect(chats.body).toHaveLength(1);
        expect(chats.body[0]).toMatchObject({ unread_count: texts });
      }
      const pending = await request(server.app).get('/api/pendientes').set(headers);
      expect(pending.status).toBe(200);
      expect(pending.body).toHaveLength(texts ? 1 : 0);
      if (texts) expect(pending.body[0].unread_count).toBe(texts);
      const queue = createSummaryQueue(server.pool, server.prepareGlobalSummary);
      const job = await queue.enqueue(accountId, 'general');
      await queue.run();
      const saved = (await server.pool.query('SELECT status,result,error FROM summary_jobs WHERE id=$1', [job.id])).rows[0];
      if (texts) {
        expect(saved.status, saved.error).toBe('completed');
        expect(saved.result).toMatchObject({ mensajes_analizados: texts, mensajes_pendientes_restantes: 0, grupos_restantes: 0, coverage: { scope: 'available_texts', pending: texts, texts } });
        expect((await server.pool.query('SELECT message_id FROM summary_reviewed_messages WHERE account_id=$1', [accountId])).rows.map((row) => row.message_id).sort()).toEqual([`${accountId}:${empty + 1}`, `${accountId}:${empty + 2}`].sort());
      } else {
        expect(saved.status).toBe('failed');
        expect(saved.error).toContain('No hay textos disponibles pendientes de analizar');
        expect(generation).not.toHaveBeenCalled();
        expect((await server.pool.query('SELECT id FROM resumenes_globales_chat WHERE account_id=$1', [accountId])).rowCount).toBe(0);
      }
      expect((await server.pool.query('SELECT id FROM mensajes WHERE account_id=$1', [accountId])).rowCount).toBe(empty + texts);
      expect((await server.pool.query('SELECT unread_count,whatsapp_unread_count FROM chats WHERE id=$1', [chatId])).rows[0]).toEqual({ unread_count: empty, whatsapp_unread_count: empty + texts });
      expect((await request(server.app).get('/api/chats').set(headers)).body[0].unread_count).toBe(0);
      expect((await request(server.app).get('/api/pendientes').set(headers)).body).toEqual([]);
      await server.pool.query("UPDATE mensajes SET raw=$2::jsonb WHERE id=$1", [`${accountId}:1`, JSON.stringify({ message: { conversation: 'Texto recuperado, vuelve a ser pendiente' } })]);
      expect((await request(server.app).get('/api/chats').set(headers)).body[0].unread_count).toBe(1);
      await server.pool.query('UPDATE chats SET unread_count=unread_count+1,whatsapp_unread_count=whatsapp_unread_count+1 WHERE id=$1', [chatId]);
      expect((await request(server.app).get('/api/chats').set(headers)).body[0].unread_count).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      generation.mockReset();
      await server.pool.query('DELETE FROM resumenes_globales_chat WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM summary_reviewed_messages WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM grupos WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM extension_activations WHERE id=$1', [activationId]);
      await server.pool.query('DELETE FROM extension_invitations WHERE id=$1', [invitationId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it.each([false, true])('distingue eventos de textos vacíos sin ocultar contenido desconocido (incompleto=%s)', async (incomplete) => {
    const accountId = `qa-message-types-${randomUUID()}`;
    const chatId = `${accountId}::120363999900005@g.us`;
    const events = ['reactionMessage', 'albumMessage', 'contactMessage', 'groupStatusMentionMessage', 'ptvMessage'];
    const unknown = ['conversation', 'secretEncryptedMessage', 'protocolMessage', 'unknown'];
    const fixtures = [
      { id: 'text', raw: { messageType: 'conversation', message: 'Texto pendiente sin envoltura' } },
      ...events.map((field) => ({ id: field, raw: { messageType: field, message: field === 'ptvMessage' ? null : { [field]: {}, messageContextInfo: {} } } })),
      ...(incomplete ? unknown.map((field) => ({ id: `empty-${field}`, raw: { messageType: field, message: field === 'conversation' ? null : { [field]: {} } } })) : []),
    ];
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: { pages: 0, records: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    generation.mockReset().mockImplementation(async (prompt: string) => evidenceResponse(prompt));
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'Tipos QA',$3,$3)", [chatId, accountId, fixtures.length]);
      for (const fixture of fixtures) await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,tipo,raw,enviado_por_mi) VALUES($1,$2,$3,'QA','','text',$4::jsonb,FALSE)", [`${accountId}:${fixture.id}`, chatId, accountId, JSON.stringify(fixture.raw)]);
      const queue = createSummaryQueue(server.pool, server.prepareGlobalSummary);
      const job = await queue.enqueue(accountId, 'general');
      await queue.run();
      const result = (await server.pool.query('SELECT status,result,error FROM summary_jobs WHERE id=$1', [job.id])).rows[0];
      const rows = (await server.pool.query('SELECT id,tipo,texto FROM mensajes WHERE account_id=$1', [accountId])).rows;
      expect(rows.find((row) => row.id === `${accountId}:text`)).toMatchObject({ tipo: 'text', texto: '' });
      for (const field of events) expect(rows.find((row) => row.id === `${accountId}:${field}`).tipo).toBe('text');
      expect(result.status, result.error).toBe('completed');
      expect(result.result).toMatchObject({ mensajes_analizados: 1, coverage: { scope: 'available_texts', texts: 1, pending: 1 } });
      expect((await server.pool.query('SELECT message_id FROM summary_reviewed_messages WHERE account_id=$1', [accountId])).rows).toEqual([{ message_id: `${accountId}:text` }]);
      expect(rows).toHaveLength(fixtures.length);
      expect((await server.pool.query('SELECT unread_count,whatsapp_unread_count FROM chats WHERE id=$1', [chatId])).rows[0]).toEqual({ unread_count: fixtures.length - 1, whatsapp_unread_count: fixtures.length });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      generation.mockReset();
      await server.pool.query('DELETE FROM resumenes_globales_chat WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM summary_reviewed_messages WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it('aísla los textos disponibles y una cuenta sin contenido no bloquea otra', async () => {
    const accountIds = [`qa-multi-${randomUUID()}`, `qa-multi-${randomUUID()}`];
    const remoteJid = '120363999900008@g.us';
    const fetcher = vi.fn().mockRejectedValue(new Error('No debe consultar Evolution'));
    vi.stubGlobal('fetch', fetcher);
    generation.mockReset().mockImplementation(async (prompt: string) => evidenceResponse(prompt));
    try {
      const queue = createSummaryQueue(server.pool, server.prepareGlobalSummary);
      for (const accountId of accountIds) {
        await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
        await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'Grupo compartido QA',10000,10000)", [`${accountId}::${remoteJid}`, accountId]);
        await queue.enqueue(accountId, 'general');
      }
      await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,enviado_por_mi) VALUES($1,$2,$3,'QA','Texto exclusivo de la segunda cuenta',FALSE)", [`${accountIds[1]}::text`, `${accountIds[1]}::${remoteJid}`, accountIds[1]]);
      await queue.run();
      for (const [index, accountId] of accountIds.entries()) {
        const job = (await server.pool.query('SELECT status,error,result FROM summary_jobs WHERE account_id=$1', [accountId])).rows[0];
        expect(job.status, job.error).toBe(index === 0 ? 'failed' : 'completed');
        const reviewed = (await server.pool.query('SELECT message_id FROM summary_reviewed_messages WHERE account_id=$1', [accountId])).rows;
        expect(reviewed).toHaveLength(index === 0 ? 0 : 1);
        if (index === 1) expect(job.result).toMatchObject({ mensajes_analizados: 1, mensajes_pendientes_restantes: 0 });
      }
      expect(fetcher).not.toHaveBeenCalled();
      expect((await server.pool.query('SELECT id FROM mensajes WHERE account_id=$1', [accountIds[0]])).rowCount).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      generation.mockReset();
      await server.pool.query('DELETE FROM resumenes_globales_chat WHERE account_id=ANY($1::varchar[])', [accountIds]);
      await server.pool.query('DELETE FROM summary_reviewed_messages WHERE account_id=ANY($1::varchar[])', [accountIds]);
      await server.pool.query('DELETE FROM chats WHERE account_id=ANY($1::varchar[])', [accountIds]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=ANY($1::varchar[])', [accountIds]);
    }
  });

  it.each([0, 20000])('no crea esperas de recuperación cuando solo hay contadores sin textos (%s)', async (pending) => {
    const accountId = `qa-mixed-history-${randomUUID()}`;
    const fetcher = vi.fn().mockRejectedValue(new Error('Sin llamadas a Evolution'));
    vi.stubGlobal('fetch', fetcher);
    generation.mockReset();
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      for (const group of ['120363999900010@g.us', '120363999900011@g.us']) await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'Sin contenido',$3,$3)", [`${accountId}::${group}`, accountId, pending]);
      const queue = createSummaryQueue(server.pool, server.prepareGlobalSummary);
      const job = await queue.enqueue(accountId, 'general');
      await queue.run();
      const saved = (await server.pool.query('SELECT * FROM summary_jobs WHERE id=$1', [job.id])).rows[0];
      expect(saved.status).toBe('failed');
      expect(saved.error).toBe('No hay textos disponibles pendientes de analizar.');
      await createSummaryQueue(server.pool, server.prepareGlobalSummary).run();
      expect(fetcher).not.toHaveBeenCalled();
      expect(generation).not.toHaveBeenCalled();
      expect((await server.pool.query('SELECT id FROM resumenes_globales_chat WHERE account_id=$1', [accountId])).rowCount).toBe(0);
      expect((await server.pool.query('SELECT message_id FROM summary_reviewed_messages WHERE account_id=$1', [accountId])).rowCount).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      generation.mockReset();
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it.each(['conversation', 'extendedTextMessage'])('el texto que llega después vuelve a ser analizable aunque WhatsApp indique cero (%s)', async (kind) => {
    const accountId = `qa-phone-${randomUUID()}`;
    const remoteJid = '120363999900009@g.us';
    const chatId = `${accountId}::${remoteJid}`;
    const fetcher = vi.fn().mockRejectedValue(new Error('Sin llamadas a Evolution'));
    vi.stubGlobal('fetch', fetcher);
    generation.mockReset().mockImplementation(async (prompt: string) => evidenceResponse(prompt));
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'Teléfono QA',0,0)", [chatId, accountId]);
      const queue = createSummaryQueue(server.pool, server.prepareGlobalSummary);
      const first = await queue.enqueue(accountId, 'general');
      await queue.run();
      expect((await server.pool.query('SELECT status FROM summary_jobs WHERE id=$1', [first.id])).rows[0].status).toBe('failed');
      expect(generation).not.toHaveBeenCalled();
      const raw = { message: kind === 'conversation' ? { conversation: 'Texto recibido después' } : { extendedTextMessage: { text: 'Texto recibido después' } } };
      await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,tipo,raw,enviado_por_mi) VALUES($1,$2,$3,'QA','','text',$4::jsonb,FALSE)", [`${accountId}::late`, chatId, accountId, JSON.stringify(raw)]);
      const next = await queue.enqueue(accountId, 'general');
      await queue.run();
      const saved = (await server.pool.query('SELECT status,result,error FROM summary_jobs WHERE id=$1', [next.id])).rows[0];
      expect(saved.status, saved.error).toBe('completed');
      expect(saved.result).toMatchObject({ mensajes_analizados: 1, mensajes_pendientes_restantes: 0 });
      expect((await server.pool.query('SELECT mensaje_ids FROM resumenes_globales_chat WHERE account_id=$1', [accountId])).rows[0].mensaje_ids).toEqual([`${accountId}::late`]);
      expect(fetcher).not.toHaveBeenCalled();
      expect((await server.pool.query('SELECT whatsapp_unread_count FROM chats WHERE id=$1', [chatId])).rows[0].whatsapp_unread_count).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      generation.mockReset();
      await server.pool.query('DELETE FROM resumenes_globales_chat WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM summary_reviewed_messages WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it.each([0, 2])('Q-evidencia: omite un texto no verificable, conserva %s válidos y descuenta solo al guardar', async (validCount) => {
    const accountId = `qa-evidence-${randomUUID()}`;
    const chatId = `${accountId}::120363999900007@g.us`;
    const messageId = `${accountId}:original`;
    const otherAccount = `${accountId}-other`;
    const invitationId = randomUUID();
    const activationId = randomUUID();
    const headers = { 'x-extension-activation': activationId };
    const fetcher = vi.fn().mockRejectedValue(new Error('No se permite red en esta regresión'));
    vi.stubGlobal('fetch', fetcher);
    generation.mockReset().mockImplementation(async (prompt: string) => {
      const data = evidencePayload(prompt);
      if (data.analysis) return evidenceResponse(prompt);
      if (data.sources) return evidenceResponse(prompt);
      const invalid = data.primary.find((item: { line: string }) => item.line.includes('Revisar planos'));
      if (!invalid) return evidenceResponse(prompt);
      return { ...evidenceResponse(prompt), text: JSON.stringify({ findings: [{
        kind: 'task', state: 'pending', topicRef: null, text: 'Revisar planos',
        evidence: [{ source: invalid.ref, quote: 'Pedro aprobó el pago' }],
      }], informational: [] }) };
    });
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [otherAccount]);
      await server.pool.query("INSERT INTO extension_invitations(id,code_hash,expires_at,created_by,account_id) VALUES($1::uuid,$1::text,NOW()+INTERVAL '1 hour','qa',$2)", [invitationId, accountId]);
      await server.pool.query('INSERT INTO extension_activations(id,invitation_id,account_id) VALUES($1,$2,$3)', [activationId, invitationId, accountId]);
      await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'QA evidencia',$3,$3)", [chatId, accountId, validCount + 1]);
      await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,enviado_por_mi) VALUES($1,$2,$3,'QA','Revisar planos',FALSE)", [messageId, chatId, accountId]);
      for (let index = 0; index < validCount; index++) await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,enviado_por_mi) VALUES($1,$2,$3,'QA','Mensaje válido',FALSE)", [`${accountId}:valid-${index}`, chatId, accountId]);
      await server.pool.query("INSERT INTO summary_skipped_messages(account_id,message_id,reason) VALUES($1,$2,'insufficient_evidence')", [otherAccount, `${accountId}:valid-0`]);
      const rollbackQueue = createSummaryQueue(server.pool, async (job) => {
        const save = await server.prepareGlobalSummary(job);
        return async (client) => { await save(client); throw new Error('Fallo SQL simulado después de guardar omisiones'); };
      });
      const job = await rollbackQueue.enqueue(accountId, 'general');
      await rollbackQueue.run();
      expect((await server.pool.query('SELECT status FROM summary_jobs WHERE id=$1', [job.id])).rows[0].status).toBe('failed');
      expect((await server.pool.query('SELECT * FROM resumenes_globales_chat WHERE account_id=$1', [accountId])).rowCount).toBe(0);
      expect((await server.pool.query('SELECT * FROM summary_reviewed_messages WHERE account_id=$1', [accountId])).rowCount).toBe(0);
      expect((await server.pool.query('SELECT * FROM summary_skipped_messages WHERE account_id=$1', [accountId])).rowCount).toBe(0);
      expect((await request(server.app).get('/api/chats').set(headers)).body[0].unread_count).toBe(validCount + 1);
      const queue = createSummaryQueue(server.pool, server.prepareGlobalSummary);
      expect((await queue.enqueue(accountId, 'general')).id).toBe(job.id);
      await queue.run();
      const saved = (await server.pool.query('SELECT status,result,error FROM summary_jobs WHERE id=$1', [job.id])).rows[0];
      expect(saved.status, saved.error).toBe('completed');
      expect(saved.result).toMatchObject({ mensajes_analizados: validCount, mensajes_omitidos: 1, mensajes_procesados: validCount + 1, mensajes_pendientes_restantes: 0 });
      const summary = (await server.pool.query('SELECT resumen,mensaje_ids,evidence FROM resumenes_globales_chat WHERE account_id=$1', [accountId])).rows[0];
      expect(summary.mensaje_ids).toHaveLength(validCount);
      expect(summary.mensaje_ids).not.toContain(messageId);
      expect(summary.resumen).not.toContain('Pedro aprobó');
      expect(summary.evidence.skippedMessages).toEqual([{ messageId, reason: 'insufficient_evidence' }]);
      expect((await server.pool.query('SELECT message_id,reason FROM summary_skipped_messages WHERE account_id=$1', [accountId])).rows).toEqual([{ message_id: messageId, reason: 'insufficient_evidence' }]);
      expect((await server.pool.query('SELECT message_id FROM summary_reviewed_messages WHERE account_id=$1', [accountId])).rowCount).toBe(validCount);
      expect((await server.pool.query('SELECT id FROM mensajes WHERE account_id=$1', [accountId])).rowCount).toBe(validCount + 1);
      expect((await server.pool.query('SELECT whatsapp_unread_count FROM chats WHERE id=$1', [chatId])).rows[0].whatsapp_unread_count).toBe(validCount + 1);
      for (let repeat = 0; repeat < 2; repeat++) {
        expect((await request(server.app).get('/api/chats').set(headers)).body[0].unread_count).toBe(0);
        expect((await request(server.app).get('/api/pendientes').set(headers)).body).toEqual([]);
      }
      const next = await queue.enqueue(accountId, 'general');
      await queue.run();
      expect((await server.pool.query('SELECT error FROM summary_jobs WHERE id=$1', [next.id])).rows[0].error).toContain('No hay textos disponibles');
      expect((await server.pool.query('SELECT id FROM resumenes_globales_chat WHERE account_id=$1', [accountId])).rowCount).toBe(1);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      generation.mockReset();
      await server.pool.query('DELETE FROM extension_activations WHERE id=$1', [activationId]);
      await server.pool.query('DELETE FROM extension_invitations WHERE id=$1', [invitationId]);
      await server.pool.query('DELETE FROM resumenes_globales_chat WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM summary_reviewed_messages WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [otherAccount]);
    }
  });

  it('Q-07: solo selecciona mensajes de texto, nunca adjuntos aunque tengan texto', () => {
    expect(server.isWhatsAppTextMessage({ tipo: 'text', texto: 'Revisar planos' } as never)).toBe(true);
    expect(server.isWhatsAppTextMessage({ texto: 'Texto histórico' } as never)).toBe(true);
    expect(server.isWhatsAppTextMessage({ tipo: 'text', texto: '   ' } as never)).toBe(false);
    for (const tipo of ['audio', 'ptt', 'image', 'video', 'ptv', 'sticker', 'document']) {
      expect(server.isWhatsAppTextMessage({ tipo, texto: 'Texto de adjunto' } as never)).toBe(false);
    }
  });

  it('Q-05: resumen y respuesta individuales excluyen audios y vídeos, disponibles o no', async () => {
    const accountId = `qa-media-${randomUUID()}`;
    const rawChat = '120363999900005@g.us';
    const chatId = `${accountId}::${rawChat}`;
    const invitationId = randomUUID();
    const activationId = randomUUID();
    const headers = { 'x-extension-activation': activationId };
    const fetcher = vi.fn().mockRejectedValue(new Error('Adjunto no disponible QA'));
    vi.stubGlobal('fetch', fetcher);
    mediaGeneration.mockReset();
    generation.mockReset().mockResolvedValue({ text: 'Solo texto procesado QA', fallback: false, provider: 'qa', model: 'stub' });
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      await server.pool.query("INSERT INTO extension_invitations(id,code_hash,expires_at,created_by,account_id) VALUES($1::uuid,$1::text,NOW()+INTERVAL '1 hour','qa',$2)", [invitationId, accountId]);
      await server.pool.query('INSERT INTO extension_activations(id,invitation_id,account_id) VALUES($1,$2,$3)', [activationId, invitationId, accountId]);
      await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'Grupo QA',4,4)", [chatId, accountId]);
      const fixtures = [
        { id: `${accountId}-audio`, tipo: 'audio', media: { base64: 'cWE=', mimetype: 'audio/ogg' }, raw: { message: { audioMessage: { mimetype: 'audio/ogg' } } } },
        { id: `${accountId}-video`, tipo: 'text', media: {}, raw: { message: { associatedChildMessage: { message: { videoMessage: { base64: 'cWE=', mimetype: 'video/mp4' } } } } } },
        { id: `${accountId}-missing`, tipo: 'audio', media: {}, raw: { message: { audioMessage: {} } } },
      ];
      for (const fixture of fixtures) await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,tipo,media,raw,enviado_por_mi) VALUES($1,$2,$3,'QA','',$4,$5::jsonb,$6::jsonb,FALSE)", [fixture.id, chatId, accountId, fixture.tipo, JSON.stringify(fixture.media), JSON.stringify(fixture.raw)]);
      const textId = `${accountId}-text`;
      await server.pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,tipo,enviado_por_mi) VALUES($1,$2,$3,'QA','Confirmar planos mañana','text',FALSE)", [textId, chatId, accountId]);
      const reply = await request(server.app).post('/api/chat/reply').set(headers).send({ chatId: rawChat });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(generation.mock.calls[0][0]).toContain('Confirmar planos mañana');
      expect((await server.pool.query('SELECT mensaje_ids FROM respuestas_chat WHERE account_id=$1', [accountId])).rows[0].mensaje_ids).toEqual([textId]);
      const response = await request(server.app).post('/api/chat/summary').set(headers).send({ chatId: rawChat });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({ mensajes_analizados: 1, mensajes_pendientes_restantes: 0 });
      expect(mediaGeneration).not.toHaveBeenCalled();
      expect((await server.pool.query('SELECT tipo FROM mensajes WHERE id=$1', [fixtures[1].id])).rows[0].tipo).toBe('video');
      expect((await server.pool.query('SELECT message_id FROM summary_reviewed_messages WHERE account_id=$1 ORDER BY message_id', [accountId])).rows.map((row) => row.message_id)).toEqual([textId]);
      const repeated = await request(server.app).post('/api/chat/summary').set(headers).send({ chatId: rawChat });
      expect(repeated.status).toBe(422);
      const mediaOnlyReply = await request(server.app).post('/api/chat/reply').set(headers).send({ chatId: rawChat });
      expect(mediaOnlyReply.status).toBe(422);
      expect(generation).toHaveBeenCalledTimes(2);
      expect(mediaGeneration).not.toHaveBeenCalled();
      expect((await server.pool.query('SELECT unread_count,whatsapp_unread_count FROM chats WHERE id=$1', [chatId])).rows[0]).toEqual({ unread_count: 3, whatsapp_unread_count: 4 });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await server.pool.query('DELETE FROM resumenes_chat WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM summary_reviewed_messages WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM mensajes WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it.each([false, true])('recepción durable: fallo, reinicio, duplicado y aislamiento de cuentas (histórico=%s)', async (historical) => {
    const accounts = [0, 1].map(() => `qa-inbox-${randomUUID()}`);
    const remoteJid = '120363999900016@g.us';
    const message = { key: { id: 'same-id', remoteJid, fromMe: false }, message: { conversation: 'Texto que debe conservarse' }, messageTimestamp: 1790000000 };
    const account = (id: string) => ({ id, nombre: 'QA', activo: true, evolutionInstanceName: id });
    const originalQuery = server.pool.query.bind(server.pool);
    let fail = true;
    const querySpy = vi.spyOn(server.pool, 'query').mockImplementation(((text: string, values: unknown[]) => {
      if (fail && typeof text === 'string' && text.includes('INSERT INTO mensajes (id, chat_id, account_id') && values?.[2] === accounts[0]) {
        return Promise.reject(new Error('Fallo transitorio sintético'));
      }
      return originalQuery(text, values);
    }) as never);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No se permite red real')));
    try {
      for (const id of accounts) {
        await originalQuery('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [id]);
        await originalQuery("INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,'QA',0,0)", [`${id}::${remoteJid}`, id]);
        const response = await request(server.app).post('/webhook/evolution').send({ instance: id, event: historical ? 'messages.set' : 'messages.upsert', data: [message, message] });
        expect(response.status).toBe(200);
      }
      const pending = (await originalQuery('SELECT id,account_id,attempts,payload FROM whatsapp_message_inbox WHERE account_id=ANY($1::varchar[])', [accounts])).rows;
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ account_id: accounts[0], attempts: 1, payload: message });
      expect((await originalQuery('SELECT account_id,texto FROM mensajes WHERE account_id=ANY($1::varchar[])', [accounts])).rows).toEqual([{ account_id: accounts[1], texto: message.message.conversation }]);
      fail = false;
      await originalQuery('UPDATE whatsapp_message_inbox SET next_attempt_at=NOW() WHERE id=$1', [pending[0].id]);
      const interrupted = createWhatsAppInbox(server.pool, async (id, payload, history) => {
        await server.persistMessage(payload, account(id), { historical: history });
        throw new Error('Interrupción después de persistir y antes de confirmar');
      });
      await interrupted.run();
      expect((await originalQuery('SELECT id FROM whatsapp_message_inbox WHERE id=$1', [pending[0].id])).rowCount).toBe(1);
      await originalQuery('UPDATE whatsapp_message_inbox SET next_attempt_at=NOW() WHERE id=$1', [pending[0].id]);
      const restarted = createWhatsAppInbox(server.pool, (id, payload, history) => server.persistMessage(payload, account(id), { historical: history }));
      await Promise.all([restarted.run(), server.whatsappInbox.run()]);
      expect((await originalQuery('SELECT id FROM whatsapp_message_inbox WHERE account_id=ANY($1::varchar[])', [accounts])).rowCount).toBe(0);
      const stored = (await originalQuery('SELECT id,texto FROM mensajes WHERE account_id=ANY($1::varchar[]) ORDER BY id', [accounts])).rows;
      expect(stored.map((row) => row.id).sort()).toEqual(accounts.map((id) => `${id}::same-id`).sort());
      expect(stored.every((row) => row.texto === message.message.conversation)).toBe(true);
      const counts = (await originalQuery('SELECT unread_count,whatsapp_unread_count FROM chats WHERE account_id=ANY($1::varchar[])', [accounts])).rows;
      expect(counts).toEqual(accounts.map(() => ({ unread_count: historical ? 0 : 1, whatsapp_unread_count: 0 })));
      expect((await originalQuery('SELECT message_id FROM summary_reviewed_messages WHERE account_id=ANY($1::varchar[])', [accounts])).rowCount).toBe(0);
    } finally {
      querySpy.mockRestore();
      vi.unstubAllGlobals();
      await originalQuery('DELETE FROM grupos WHERE account_id=ANY($1::varchar[])', [accounts]);
      await originalQuery('DELETE FROM chats WHERE account_id=ANY($1::varchar[])', [accounts]);
      await originalQuery('DELETE FROM whatsapp_accounts WHERE id=ANY($1::varchar[])', [accounts]);
    }
  });

  it('un fallo real del contador revierte también el mensaje y la cola lo recupera una sola vez', async () => {
    const accountId = `qa-atomic-${randomUUID()}`;
    const constraint = `qa_counter_${randomUUID().replaceAll('-', '')}`;
    const remoteJid = '120363999900019@g.us';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Sin red real')));
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      await server.pool.query("INSERT INTO chats(id,account_id,nombre,unread_count) VALUES($1,$2,'QA',0)", [`${accountId}::${remoteJid}`, accountId]);
      await server.pool.query(`ALTER TABLE chats ADD CONSTRAINT ${constraint} CHECK(account_id <> '${accountId}' OR unread_count=0) NOT VALID`);
      const response = await request(server.app).post('/webhook/evolution').send({ instance: accountId, event: 'messages.upsert', data: [{ key: { id: 'atomic', remoteJid, fromMe: false }, message: { conversation: 'Texto atómico' }, messageTimestamp: 1790000000 }] });
      expect(response.status).toBe(200);
      expect((await server.pool.query('SELECT id FROM mensajes WHERE account_id=$1', [accountId])).rowCount).toBe(0);
      expect((await server.pool.query('SELECT attempts FROM whatsapp_message_inbox WHERE account_id=$1', [accountId])).rows).toEqual([{ attempts: 1 }]);
      await server.pool.query(`ALTER TABLE chats DROP CONSTRAINT ${constraint}`);
      await server.pool.query('UPDATE whatsapp_message_inbox SET next_attempt_at=NOW() WHERE account_id=$1', [accountId]);
      await server.whatsappInbox.run();
      await server.whatsappInbox.run();
      expect((await server.pool.query('SELECT texto FROM mensajes WHERE account_id=$1', [accountId])).rows).toEqual([{ texto: 'Texto atómico' }]);
      expect((await server.pool.query('SELECT unread_count FROM chats WHERE account_id=$1', [accountId])).rows).toEqual([{ unread_count: 1 }]);
      expect((await server.pool.query('SELECT id FROM whatsapp_message_inbox WHERE account_id=$1', [accountId])).rowCount).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      await server.pool.query(`ALTER TABLE chats DROP CONSTRAINT IF EXISTS ${constraint}`);
      await server.pool.query('DELETE FROM grupos WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it('no confirma recepción si no puede guardarla en la cola persistente', async () => {
    const accountId = `qa-inbox-down-${randomUUID()}`;
    const accept = vi.spyOn(server.whatsappInbox, 'accept').mockRejectedValueOnce(new Error('Cola no disponible'));
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      const response = await request(server.app).post('/webhook/evolution').send({ instance: accountId, event: 'messages.upsert', data: [{ key: { id: 'qa', remoteJid: '120363999900016@g.us' }, message: { conversation: 'QA' } }] });
      expect(response.status).toBe(500);
      expect((await server.pool.query('SELECT id FROM mensajes WHERE account_id=$1', [accountId])).rowCount).toBe(0);
    } finally {
      accept.mockRestore();
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it('audita fallos, solicita contenido faltante y verifica IDs tras reconectar sin consumir mensajes', async () => {
    const accountId = `qa-reconnect-${randomUUID()}`;
    const remoteJid = '120363999900017@g.us';
    let state = 'offline';
    const fetcher = vi.fn(async (url: string) => {
      if (state === 'offline') throw new Error('Desconectado');
      if (url.endsWith(`/chat/findChats/${accountId}`)) return new Response(JSON.stringify([{ remoteJid, name: 'QA reconexión', unreadMessages: 2 }]));
      if (url.endsWith(`/chat/requestHistory/${accountId}`)) return new Response(JSON.stringify({ status: 'no_anchor' }));
      expect(url).toContain(`/chat/findMessages/${accountId}`);
      return new Response(JSON.stringify({ messages: { pages: state === 'gap' ? 0 : 1, records: state === 'gap' ? [] : [1, 2].map((index) => ({ key: { id: `restored-${index}`, remoteJid, fromMe: false }, message: { conversation: `Texto exacto ${index}` }, messageTimestamp: 1790000000 + index })) } }));
    });
    vi.stubGlobal('fetch', fetcher);
    const account = { id: accountId, nombre: 'QA', activo: true, evolutionInstanceName: accountId };
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      await expect(server.syncEvolutionData(account)).rejects.toThrow();
      expect((await server.pool.query('SELECT state FROM whatsapp_sync_health WHERE account_id=$1', [accountId])).rows[0].state).toBe('error');
      state = 'gap';
      await server.syncEvolutionData(account);
      const blocked = (await server.pool.query('SELECT state,details FROM whatsapp_sync_health WHERE account_id=$1', [accountId])).rows[0];
      expect(blocked.state).toBe('gaps_detected');
      expect(blocked.details.gaps[0]).toMatchObject({ pending: 2, unavailable: 2 });
      expect(blocked.details.recovery).toEqual([{ group: remoteJid, status: 'no_anchor' }]);
      state = 'online';
      await server.syncEvolutionData(account);
      await server.syncEvolutionData(account);
      const stored = (await server.pool.query('SELECT id,texto FROM mensajes WHERE account_id=$1 ORDER BY id', [accountId])).rows;
      expect(stored).toEqual([1, 2].map((index) => ({ id: `${accountId}::restored-${index}`, texto: `Texto exacto ${index}` })));
      const response = await request(server.app).get(`/api/whatsapp-accounts/${accountId}/sync-health`).set('Authorization', authorization);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ account_id: accountId, health: { state: 'no_known_gaps' }, inbox: { pending: 0, retrying: 0 } });
      expect((await request(server.app).get(`/api/whatsapp-accounts/${accountId}/sync-health`)).status).toBe(401);
      expect((await server.pool.query('SELECT unread_count,whatsapp_unread_count FROM chats WHERE account_id=$1', [accountId])).rows[0]).toEqual({ unread_count: 2, whatsapp_unread_count: 2 });
      expect((await server.pool.query('SELECT message_id FROM summary_reviewed_messages WHERE account_id=$1', [accountId])).rowCount).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      await server.pool.query('DELETE FROM grupos WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it('Q-04: conserva 39 pendientes de Evolution al importar y repetir historial', async () => {
    const accountId = `qa-history-${randomUUID()}`;
    const rawChat = '120363999900004@g.us';
    const chatId = `${accountId}::${rawChat}`;
    const messages = Array.from({ length: 45 }, (unusedValue, index) => ({
      key: { id: `history-${index}`, remoteJid: rawChat, fromMe: false },
      message: { conversation: `Mensaje histórico QA ${index}` },
      messageTimestamp: 1780000000 + index,
      status: 'DELIVERY_ACK',
    }));
    const post = (event: string, data: unknown) => request(server.app).post('/webhook/evolution').send({ instance: accountId, event, data });
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      expect((await post('chats.set', [{ remoteJid: rawChat, name: 'Grupo QA historial', unreadMessages: 39 }])).status).toBe(200);
      expect((await post('messages.set', messages)).status).toBe(200);
      expect((await post('messages.set', messages)).status).toBe(200);
      expect((await server.pool.query('SELECT COUNT(*)::int AS total FROM mensajes WHERE account_id=$1', [accountId])).rows[0].total).toBe(45);
      expect((await server.pool.query('SELECT unread_count,whatsapp_unread_count FROM chats WHERE id=$1', [chatId])).rows[0]).toEqual({ unread_count: 39, whatsapp_unread_count: 39 });
      await server.pool.query('UPDATE chats SET reviewed_unread_baseline=10,unread_count=29 WHERE id=$1', [chatId]);
      expect((await post('chats.upsert', [{ remoteJid: rawChat, name: 'Grupo QA historial', unreadMessages: 39 }])).status).toBe(200);
      expect((await post('chats.update', [{ remoteJid: rawChat, name: 'Grupo QA renombrado' }])).status).toBe(200);
      expect((await server.pool.query('SELECT unread_count,whatsapp_unread_count FROM chats WHERE id=$1', [chatId])).rows[0]).toEqual({ unread_count: 29, whatsapp_unread_count: 39 });
      expect((await post('chats.update', [{ remoteJid: rawChat, unreadMessages: 0 }])).status).toBe(200);
      expect((await server.pool.query('SELECT unread_count,reviewed_unread_baseline FROM chats WHERE id=$1', [chatId])).rows[0]).toEqual({ unread_count: 0, reviewed_unread_baseline: 0 });
    } finally {
      await server.pool.query('DELETE FROM mensajes WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM grupos WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
    }
  });

  it('Drive automático: importa pese a un archivo denegado, reintenta y analiza una vez por versión sin intervención', async () => {
    const automaticConnection = randomUUID();
    const automaticFolder = randomUUID();
    const goodId = `qa-september-${randomUUID()}`;
    const deniedId = `qa-denied-${randomUUID()}`;
    let denied = true;
    const previousGeneration = generation.getMockImplementation();
    const file = (id: string) => ({ id, name: 'Reunión iniciada a las 2026/09/25 09:10 CEST - Notas de Gemini', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-09-25T12:00:00Z' });
    await server.pool.query(`INSERT INTO google_drive_connections (id, google_email, access_token_encrypted, refresh_token_encrypted, expires_at, created_by) SELECT $1, $2, access_token_encrypted, refresh_token_encrypted, expires_at, 'qa' FROM google_drive_connections WHERE id=$3`, [automaticConnection, `${automaticConnection}@example.test`, connectionId]);
    await server.pool.query(`INSERT INTO google_drive_folders (id, connection_id, google_folder_id, label, created_by) VALUES ($1::uuid, $2, $1::text, 'QA automática septiembre', 'qa')`, [automaticFolder, automaticConnection]);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/files/${automaticFolder}`)) return new Response(JSON.stringify({ id: automaticFolder, mimeType: 'application/vnd.google-apps.folder' }));
      if (url.pathname.endsWith('/files')) return new Response(JSON.stringify({ files: [file(deniedId), { id: 'qa-shortcut', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: goodId } }, file(goodId)] }));
      if (url.pathname.endsWith(`/files/${goodId}`)) return new Response(JSON.stringify(file(goodId)));
      if (url.pathname.endsWith('/export')) {
        if (denied && url.pathname.includes(deniedId)) return new Response('denied', { status: 403 });
        return new Response('Reunión 25/09/2026. Se revisaron los planos de la obra. Hay que confirmar las medidas del baño con el PMC antes del viernes.');
      }
      throw new Error(`Solicitud inesperada de prueba: ${url.pathname}`);
    });
    generation.mockResolvedValue({ text: '{"summary":"Resumen automático QA","actions":[],"blockers":[]}', fallback: false, provider: 'qa', model: 'stub' });
    try {
      const first = await server.syncEnabledGoogleDriveFolders();
      expect(first.imported).toBe(1);
      expect(first.failed).toBe(1);
      const partial = await server.pool.query('SELECT last_synced_at, last_sync_error FROM google_drive_folders WHERE id=$1', [automaticFolder]);
      expect(partial.rows[0].last_synced_at).toBeNull();
      expect(partial.rows[0].last_sync_error).toContain('403');
      const imported = await server.pool.query('SELECT a.id, r.analysis_status FROM google_drive_artifacts a JOIN meeting_reviews r ON r.artifact_id=a.id WHERE a.google_file_id=$1', [goodId]);
      expect(imported.rows).toHaveLength(1);
      expect(imported.rows[0].analysis_status).toBe('pending');
      denied = false;
      expect((await server.syncEnabledGoogleDriveFolders()).imported).toBe(1);
      for (let attempt = 0; attempt < 5; attempt += 1) await server.processPendingMeetingAnalyses();
      const completed = await server.pool.query('SELECT r.analysis_status FROM meeting_reviews r JOIN google_drive_artifacts a ON a.id=r.artifact_id WHERE a.connection_id=$1', [automaticConnection]);
      expect(completed.rows).toHaveLength(2);
      expect(completed.rows.every((row) => row.analysis_status === 'completed')).toBe(true);
      expect((await server.syncEnabledGoogleDriveFolders()).imported).toBe(0);
      await server.processPendingMeetingAnalyses();
      const runs = await server.pool.query('SELECT COUNT(*)::int AS total FROM meeting_review_ai_runs r JOIN google_drive_artifacts a ON a.id=r.artifact_id WHERE a.connection_id=$1', [automaticConnection]);
      expect(runs.rows[0].total).toBe(2);
      const recovered = await server.pool.query('SELECT last_synced_at, last_sync_error FROM google_drive_folders WHERE id=$1', [automaticFolder]);
      expect(recovered.rows[0].last_synced_at).not.toBeNull();
      expect(recovered.rows[0].last_sync_error).toBeNull();
      const response = await request(server.app).get(`/api/meetings/${imported.rows[0].id}`).set('Authorization', authorization);
      expect(response.status).toBe(200);
      expect(response.body.summary).toBe('Resumen automático QA');
    } finally {
      fetchMock.mockRestore();
      generation.mockImplementation(previousGeneration || (() => undefined));
      await server.pool.query('DELETE FROM google_drive_connections WHERE id=$1', [automaticConnection]);
    }
  });

  it('Q-03: leer en WhatsApp restablece la base y un mensaje nuevo vuelve a contar', async () => {
    const accountId=`qa-counter-${randomUUID()}`;
    const rawChat='120363999900003@g.us';
    const chatId=`${accountId}::${rawChat}`;
    const account={id:accountId,nombre:'QA',activo:true,evolutionInstanceName:accountId};
    try {
      await server.pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)',[accountId]);
      await server.persistChat({remoteJid:rawChat,name:'Grupo QA',unreadCount:5} as never,account);
      await server.pool.query('UPDATE chats SET unread_count=0,reviewed_unread_baseline=5 WHERE id=$1',[chatId]);
      await server.persistChat({remoteJid:rawChat,name:'Grupo QA',unreadCount:0} as never,account);
      await server.persistChat({remoteJid:rawChat,name:'Grupo QA',unreadCount:1} as never,account);
      expect((await server.pool.query('SELECT unread_count,reviewed_unread_baseline FROM chats WHERE id=$1',[chatId])).rows[0]).toEqual({unread_count:1,reviewed_unread_baseline:0});
    }finally{
      await server.pool.query('DELETE FROM grupos WHERE id=$1',[chatId]);
      await server.pool.query('DELETE FROM chats WHERE id=$1',[chatId]);
      await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1',[accountId]);
    }
  });

});
