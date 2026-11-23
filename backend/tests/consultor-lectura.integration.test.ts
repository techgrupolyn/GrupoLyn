import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Rol consultor_lectura en el servidor REAL (server.ts): un usuario local entra por el login del Dashboard, ve Netelip y todas
// las reuniones en solo lectura, y nada más. Datos ficticios, en la base QA desechable.
const databaseUrl = process.env.QA_TEST_DATABASE_URL;
const CONTRASENA = 'contrasena-ficticia-de-prueba';
const USUARIO = 'prueba.consultor';

describe.skipIf(!databaseUrl)('Consultor de solo lectura en el servidor real', () => {
  let server: typeof import('../server.ts');
  let token = '';
  const connectionId = randomUUID();
  const folderId = randomUUID();
  const artifactId = randomUUID();
  const actionId = randomUUID();

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/lyn_qa_retest') throw new Error('Solo base local QA');
    process.env.DATABASE_URL = databaseUrl;
    process.env.CEO_SESSION_SECRET ||= 'consultor-lectura-test-only';
    process.env.SUPABASE_SYNC_ENABLED = 'false';
    process.env.EVOLUTION_BACKGROUND_SYNC_ENABLED = 'false';
    process.env.MEETING_AI_BACKGROUND_ANALYSIS_ENABLED = 'false';
    server = await import('../server.ts');
    await server.ensureDatabaseSchema();
    const db = server.pool;
    await db.query(`INSERT INTO google_drive_connections (id, google_email, access_token_encrypted, refresh_token_encrypted, created_by) VALUES ($1, $2, 'unused', 'unused', 'qa')`, [connectionId, `${connectionId}@example.test`]);
    await db.query(`INSERT INTO google_drive_folders (id, connection_id, google_folder_id, label, created_by) VALUES ($1::uuid, $2, $1::text, 'Carpeta QA', 'qa')`, [folderId, connectionId]);
    await db.query(`INSERT INTO google_drive_artifacts (id, connection_id, folder_id, google_file_id, name, mime_type, artifact_type, content_text) VALUES ($1::uuid, $2, $3, $1::text, 'Reunión ficticia', 'text/plain', 'transcript', 'Texto ficticio')`, [artifactId, connectionId, folderId]);
    // Reunión sin PMC ni proyecto: un empleado normal no la vería; el consultor ve todas.
    await db.query(`INSERT INTO meeting_reviews (artifact_id, summary, analysis_status, workflow_stage, status) VALUES ($1, 'Resumen ficticio', 'completed', 'pmc', 'pending')`, [artifactId]);
    await db.query(`INSERT INTO meeting_review_actions (id, artifact_id, title, status) VALUES ($1, $2, 'Acción ficticia', 'pending')`, [actionId, artifactId]);
    const { guardarUsuarioConsultor } = await import('../usuarios-consultor.ts');
    await guardarUsuarioConsultor(db, { usuario: USUARIO, nombre: 'Consultor de prueba', contrasena: CONTRASENA });
    const login = await request(server.app).post('/api/auth/ceo-login').send({ usuario: USUARIO, contraseña: CONTRASENA });
    expect(login.status).toBe(200);
    expect(login.body.usuario.rol).toBe('consultor_lectura');
    token = login.body.token;
  }, 60000);

  afterAll(async () => {
    if (!server) return;
    await server.pool.query('DELETE FROM meeting_review_actions WHERE id = $1', [actionId]);
    await server.pool.query('DELETE FROM meeting_reviews WHERE artifact_id = $1', [artifactId]);
    await server.pool.query('DELETE FROM google_drive_artifacts WHERE id = $1', [artifactId]);
    await server.pool.query('DELETE FROM google_drive_folders WHERE id = $1', [folderId]);
    await server.pool.query('DELETE FROM google_drive_connections WHERE id = $1', [connectionId]);
    await server.pool.query('DELETE FROM usuarios WHERE usuario = $1', [USUARIO]);
    await server.pool.end();
  });

  const llamar = (metodo: 'get' | 'post' | 'put' | 'delete', ruta: string) => request(server.app)[metodo](ruta).set('Authorization', `Bearer ${token}`);

  it('ve el historial de llamadas pero no escribe en Netelip', async () => {
    const lista = await llamar('get', '/api/netelip/calls?page=1');
    expect(lista.status).toBe(200);
    expect(Array.isArray(lista.body.items)).toBe(true);
    const escritura = await llamar('put', '/api/netelip/comerciales/100').send({});
    expect(escritura.status).toBe(403);
    expect(escritura.body.error).toBe('Tu acceso a las llamadas es de solo lectura.');
  });

  it('ve todas las reuniones y su detalle, sin permisos de edición ni directorio', async () => {
    const lista = await llamar('get', '/api/meetings?page=1');
    expect(lista.status).toBe(200);
    expect(JSON.stringify(lista.body)).toContain(artifactId);
    expect((await llamar('get', '/api/meetings/filter-options')).status).toBe(200);
    const detalle = await llamar('get', `/api/meetings/${artifactId}`);
    expect(detalle.status).toBe(200);
    expect(detalle.body.summary).toBe('Resumen ficticio');
    expect(detalle.body.actions).toHaveLength(1);
    expect(detalle.body.permissions).toEqual({ manageActions: false, deleteActions: false, editMeeting: false, review: false, assignOrganizer: false });
    expect(detalle.body.assignment_directory).toEqual({ employees: [], clients: [] });
  });

  it('no cambia nada en reuniones', async () => {
    const escrituras: Array<['post' | 'put' | 'delete', string]> = [
      ['put', `/api/meetings/${artifactId}`],
      ['post', `/api/meetings/${artifactId}/analyze`],
      ['post', `/api/meetings/${artifactId}/workflow`],
      ['post', `/api/meetings/${artifactId}/actions`],
      ['put', `/api/meetings/${artifactId}/actions/${actionId}`],
      ['delete', `/api/meetings/${artifactId}/actions/${actionId}`],
      ['post', `/api/meetings/${artifactId}/recording-notice`],
      ['post', '/api/meetings/retag'],
      ['post', '/api/meetings/reanalyze-missing-pmc'],
      ['put', '/api/meetings/configuration'],
      ['post', '/api/meetings/work-items/read'],
    ];
    for (const [metodo, ruta] of escrituras) expect((await llamar(metodo, ruta).send({ title: 'x', action: 'approve' })).status, `${metodo} ${ruta}`).toBe(403);
    const accion = await server.pool.query('SELECT title FROM meeting_review_actions WHERE id = $1', [actionId]);
    expect(accion.rows[0].title).toBe('Acción ficticia');
  });

  it('no ve nada más del Dashboard', async () => {
    for (const ruta of ['/api/whatsapp-accounts', '/api/ceo/metrics', '/api/marketing/resumen', '/api/directory', '/api/meetings/configuration',
      '/api/meetings/work-items', '/api/project-meetings/mode', '/api/protocolos/consultas', '/api/captacion/whatsapp/avisos']) {
      expect((await llamar('get', ruta)).status, ruta).toBe(403);
    }
  });

  it('un usuario desactivado ya no entra', async () => {
    const { desactivarUsuarioConsultor } = await import('../usuarios-consultor.ts');
    await desactivarUsuarioConsultor(server.pool, USUARIO);
    const login = await request(server.app).post('/api/auth/ceo-login').send({ usuario: USUARIO, contraseña: CONTRASENA });
    expect(login.status).toBe(401);
  });
});
