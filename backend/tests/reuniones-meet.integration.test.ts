// Reuniones de Meet (869fppbcj) contra PostgreSQL de QA local: el SQL real de esquema, ingesta y vinculación.
// Trabaja en un esquema propio que se borra al terminar; no toca las tablas del esquema public.
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ensureReunionesMeet } from '../reuniones-meet/schema.ts';
import { ingestarTranscripciones, reabrirSinRubrica, vincularPendientes } from '../reuniones-meet/proceso.ts';

const databaseUrl = process.env.QA_TEST_DATABASE_URL;
const ESQUEMA = `reuniones_meet_test_${process.pid}`;

describe.skipIf(!databaseUrl)('Reuniones Meet en PostgreSQL QA local', () => {
  let client: Client;
  let pool: Pool;
  const estados = async () => Object.fromEntries((await client.query('SELECT titulo, estado, fase, empleado_id, motivo FROM reunion ORDER BY titulo')).rows.map((r) => [r.titulo, r]));

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    const localPort = url.port === '15439' || (process.env.CI === 'true' && url.port === '5432');
    if (url.hostname !== '127.0.0.1' || !localPort || url.pathname !== '/lyn_qa_retest') throw new Error('Solo QA local');
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    pool = client as unknown as Pool;
    await client.query(`CREATE SCHEMA ${ESQUEMA}; SET search_path TO ${ESQUEMA};
      CREATE TABLE empleados (id VARCHAR(255) PRIMARY KEY, nombre VARCHAR(255) NOT NULL, email VARCHAR(255), activo BOOLEAN NOT NULL DEFAULT TRUE);
      CREATE TABLE google_drive_connections (id UUID PRIMARY KEY, revoked_at TIMESTAMPTZ);
      CREATE TABLE google_drive_folders (id UUID PRIMARY KEY, connection_id UUID REFERENCES google_drive_connections(id), enabled BOOLEAN NOT NULL DEFAULT TRUE);
      CREATE TABLE google_drive_artifacts (id UUID PRIMARY KEY, connection_id UUID NOT NULL REFERENCES google_drive_connections(id), folder_id UUID REFERENCES google_drive_folders(id),
        google_file_id VARCHAR(255) NOT NULL, name VARCHAR(1024) NOT NULL, artifact_type VARCHAR(40) NOT NULL, content_text TEXT,
        source_modified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (connection_id, google_file_id));
      CREATE TABLE meeting_reviews (artifact_id UUID PRIMARY KEY REFERENCES google_drive_artifacts(id), meeting_date DATE);
      CREATE TABLE meeting_artifact_organizers (artifact_id UUID PRIMARY KEY REFERENCES google_drive_artifacts(id), employee_id VARCHAR(255) NOT NULL,
        assigned_by TEXT NOT NULL, assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE comercial_rol (extension_netelip TEXT PRIMARY KEY, empleado_id VARCHAR(255) REFERENCES empleados(id), nombre TEXT NOT NULL, rol TEXT NOT NULL,
        activo BOOLEAN NOT NULL DEFAULT TRUE, creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(), actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW());

      INSERT INTO empleados VALUES ('ernesto','Ernesto','ernesto@grupolyn.com',TRUE), ('diseno','Diseño','diseno@grupolyn.com',TRUE);
      INSERT INTO comercial_rol (extension_netelip, empleado_id, nombre, rol) VALUES ('meet-ernesto','ernesto','Ernesto','closer_f2');
      INSERT INTO google_drive_connections VALUES ('00000000-0000-0000-0000-00000000c001',NULL), ('00000000-0000-0000-0000-00000000c002',NULL);
      INSERT INTO google_drive_folders VALUES ('00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-00000000c001',TRUE),
                                              ('00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-00000000c002',TRUE);
      INSERT INTO google_drive_artifacts (id, connection_id, folder_id, google_file_id, name, artifact_type, content_text, source_modified_at, created_at) VALUES
        ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000c001','00000000-0000-0000-0000-00000000f001','file-visita','F2 · Visita García - Transcripción','transcript','00:00:05 Ernesto: ¿Grabamos? 00:52:10 Cliente: Hasta luego.','2026-11-10 10:00+00','2026-11-10 11:00+00'),
        -- el mismo archivo visto desde otra cuenta: debe contar una sola vez
        ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-00000000c002','00000000-0000-0000-0000-00000000f002','file-visita','F2 · Visita García - Transcripción','transcript','00:00:05 Ernesto: ¿Grabamos?','2026-11-10 10:00+00','2026-11-10 12:00+00'),
        ('00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-00000000c001','00000000-0000-0000-0000-00000000f001','file-negativa','F3 · Presentación López - Transcripción','transcript','Cliente: prefiero que no se grabe.','2026-11-10 10:00+00','2026-11-10 11:00+00'),
        ('00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-00000000c001','00000000-0000-0000-0000-00000000f001','file-diseno','Reunión de diseño - Transcripción','transcript','Hablamos de planos.','2026-11-10 10:00+00','2026-11-10 11:00+00'),
        ('00000000-0000-0000-0000-0000000000a5','00000000-0000-0000-0000-00000000c001','00000000-0000-0000-0000-00000000f001','file-notas','Notas de Gemini','notes','Resumen','2026-11-10 10:00+00','2026-11-10 11:00+00'),
        ('00000000-0000-0000-0000-0000000000a6','00000000-0000-0000-0000-00000000c001','00000000-0000-0000-0000-00000000f001','file-vacia','F2 · Vacía - Transcripción','transcript','   ','2026-11-10 10:00+00','2026-11-10 11:00+00');
      INSERT INTO meeting_reviews VALUES ('00000000-0000-0000-0000-0000000000a1','2026-11-09');
      INSERT INTO meeting_artifact_organizers (artifact_id, employee_id, assigned_by) VALUES
        ('00000000-0000-0000-0000-0000000000a1','ernesto','calendar:1'), ('00000000-0000-0000-0000-0000000000a3','ernesto','calendar:2'),
        ('00000000-0000-0000-0000-0000000000a4','diseno','calendar:3');`);
    await ensureReunionesMeet(pool);
    await ensureReunionesMeet(pool);   // idempotente: el arranque lo aplica cada vez
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
    await client.end();
  });

  it('ingesta: solo transcripciones con texto, una por archivo aunque esté en dos cuentas, y sin duplicar al repetir', async () => {
    expect(await ingestarTranscripciones(pool)).toBe(3);
    expect(await ingestarTranscripciones(pool)).toBe(0);
    const { rows } = await client.query(`SELECT artifact_id::text, fecha_reunion::text FROM reunion WHERE google_file_id = 'file-visita'`);
    expect(rows).toEqual([{ artifact_id: '00000000-0000-0000-0000-0000000000a1', fecha_reunion: '2026-11-09' }]);
  });

  it('vinculación: sin_rubrica, sin_consentimiento y sin_comercial según el caso', async () => {
    expect(await vincularPendientes(pool)).toBe(3);
    const e = await estados();
    expect(e['F2 · Visita García - Transcripción']).toMatchObject({ estado: 'sin_rubrica', fase: 'F2', empleado_id: 'ernesto', motivo: 'No hay rúbrica activa para F2.' });
    expect(e['F3 · Presentación López - Transcripción']).toMatchObject({ estado: 'sin_consentimiento' });
    expect(e['Reunión de diseño - Transcripción']).toMatchObject({ estado: 'sin_comercial', empleado_id: 'diseno' });
    const { rows } = await client.query(`SELECT duracion_segundos FROM reunion WHERE google_file_id = 'file-visita'`);
    expect(rows[0].duracion_segundos).toBe(52 * 60 + 10);
    expect(await vincularPendientes(pool)).toBe(0);
  });

  it('dar de alta al comercial después vuelve a vincular la sin_comercial', async () => {
    await client.query(`INSERT INTO comercial_rol (extension_netelip, empleado_id, nombre, rol) VALUES ('meet-diseno','diseno','Diseño','closer_f3')`);
    expect(await vincularPendientes(pool)).toBe(1);
    expect((await estados())['Reunión de diseño - Transcripción']).toMatchObject({ estado: 'sin_rubrica', fase: null });
  });

  it('rúbrica de F2 activada después: reabrir y vincular las deja por_evaluar con esa versión; la negativa no se toca', async () => {
    await client.query(`CREATE TABLE rubrica_version (id SERIAL PRIMARY KEY, rol TEXT, fase TEXT, version TEXT NOT NULL, vigente_desde TIMESTAMPTZ DEFAULT NOW(), activo BOOLEAN NOT NULL DEFAULT FALSE);
      INSERT INTO rubrica_version (rol, fase, version, activo) VALUES ('closer_f2','F2','f2-v1',TRUE)`);
    expect(await reabrirSinRubrica(pool, 'F2')).toBe(1);   // solo la de F2; la que no tiene fase sigue igual
    await vincularPendientes(pool);
    const { rows } = await client.query(`SELECT titulo, estado, version_rubrica FROM reunion ORDER BY titulo`);
    expect(rows).toEqual([
      { titulo: 'F2 · Visita García - Transcripción', estado: 'por_evaluar', version_rubrica: 'f2-v1' },
      { titulo: 'F3 · Presentación López - Transcripción', estado: 'sin_consentimiento', version_rubrica: null },
      { titulo: 'Reunión de diseño - Transcripción', estado: 'sin_rubrica', version_rubrica: null },
    ]);
  });
});
