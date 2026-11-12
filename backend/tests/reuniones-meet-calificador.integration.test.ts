// Migración del calificador para reuniones (869fppbcj) sobre las tablas REALES de Juan (ensureCalificador), en un
// esquema propio de PostgreSQL QA local. Comprueba que lo nuevo funciona y que su cola y su alta de comerciales no se rompen.
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ensureCalificador } from '../netelip/calificador/schema.ts';
import { enviarPendientes, procesarSiguienteEvaluacion } from '../netelip/calificador/proceso.ts';
import { ensureReunionesMeet } from '../reuniones-meet/schema.ts';
import { adaptarCalificador } from '../reuniones-meet/migracion-calificador.ts';

const databaseUrl = process.env.QA_TEST_DATABASE_URL;
const ESQUEMA = `reuniones_calificador_test_${process.pid}`;

describe.skipIf(!databaseUrl)('Migración del calificador para reuniones en PostgreSQL QA local', () => {
  let client: Client;
  let pool: Pool;
  let reunionId: string;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    const localPort = url.port === '15439' || (process.env.CI === 'true' && url.port === '5432');
    if (url.hostname !== '127.0.0.1' || !localPort || url.pathname !== '/lyn_qa_retest') throw new Error('Solo QA local');
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    pool = client as unknown as Pool;
    await client.query(`CREATE SCHEMA ${ESQUEMA}; SET search_path TO ${ESQUEMA};
      CREATE TABLE empleados (id VARCHAR(255) PRIMARY KEY, nombre VARCHAR(255) NOT NULL, email VARCHAR(255), activo BOOLEAN NOT NULL DEFAULT TRUE);
      CREATE TABLE clientes (id VARCHAR(255) PRIMARY KEY, nombre TEXT, apellido TEXT);
      CREATE TABLE crm_leads (id UUID PRIMARY KEY, name TEXT);
      CREATE TABLE netelip_calls (id BIGSERIAL PRIMARY KEY, agent_extension TEXT, direction TEXT, duration_seconds INTEGER,
        occurred_at TIMESTAMPTZ DEFAULT NOW(), lead_id UUID, client_id VARCHAR(255));
      CREATE TABLE netelip_call_transcriptions (call_id BIGINT PRIMARY KEY, status TEXT, text TEXT, segments JSONB);
      CREATE TABLE google_drive_connections (id UUID PRIMARY KEY, revoked_at TIMESTAMPTZ);
      CREATE TABLE google_drive_artifacts (id UUID PRIMARY KEY, connection_id UUID, folder_id UUID, google_file_id TEXT, name TEXT,
        artifact_type TEXT, content_text TEXT, source_modified_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO empleados VALUES ('sdr','Laura','laura@lyn.example',TRUE), ('ernesto','Ernesto','ernesto@lyn.example',TRUE), ('nuevo','Raúl','raul@lyn.example',TRUE);
      INSERT INTO google_drive_artifacts (id, google_file_id, name, artifact_type) VALUES ('00000000-0000-0000-0000-0000000000a1','f1','F2 · Visita','transcript');`);
    // Estado de producción antes de la migración: las tablas de Juan tal cual, con datos.
    await ensureCalificador(pool);
    await client.query(`
      INSERT INTO comercial_rol (extension_netelip, empleado_id, nombre, rol) VALUES ('101','sdr','Laura','sdr');
      INSERT INTO netelip_calls (agent_extension, direction, duration_seconds) VALUES ('101','outbound',300);
      INSERT INTO llamada_evaluacion (llamada_id, extension_netelip, rol, estado) VALUES (1,'101','sdr','evaluada');
      INSERT INTO objecion_marketing (llamada_id, evaluacion_id, tipo_objecion, cita) VALUES (1,1,'precio','Me parece caro para lo que es.');`);
    await ensureReunionesMeet(pool);
    await ensureReunionesMeet(pool);   // el siguiente arranque no falla ni duplica nada
    reunionId = (await client.query(`INSERT INTO reunion (artifact_id, google_file_id, titulo) VALUES ('00000000-0000-0000-0000-0000000000a1','f1','F2 · Visita') RETURNING id`)).rows[0].id;
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
    await client.end();
  });

  it('comercial_rol: clave id, la fila existente se conserva y un closer se da de alta sin extensión y con closer_f4', async () => {
    const { rows: [laura] } = await client.query(`SELECT id, extension_netelip, rol FROM comercial_rol WHERE empleado_id = 'sdr'`);
    expect(laura).toMatchObject({ extension_netelip: '101', rol: 'sdr' });
    expect(laura.id).toBeTruthy();
    const { rows: [pk] } = await client.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'comercial_rol'::regclass AND contype = 'p'`);
    expect(pk.def).toBe('PRIMARY KEY (id)');
    await client.query(`INSERT INTO comercial_rol (empleado_id, nombre, rol) VALUES ('ernesto','Ernesto','closer_f2'), ('nuevo','Raúl','closer_f4')`);
    await expect(client.query(`INSERT INTO comercial_rol (empleado_id, nombre, rol) VALUES ('ernesto','Ernesto','closer_f3')`)).rejects.toThrow(/comercial_rol_empleado_id_key/);
    await expect(client.query(`INSERT INTO comercial_rol (empleado_id, nombre, rol) VALUES (NULL,'X','jefe')`)).rejects.toThrow(/comercial_rol_rol_check/);
  });

  it('comercial_rol: el alta del Dashboard de Juan (ON CONFLICT (extension_netelip)) sigue funcionando', async () => {
    // La misma consulta que rutas.ts › PUT /api/netelip/comerciales/:extension
    const upsert = `INSERT INTO comercial_rol (extension_netelip, empleado_id, nombre, rol, whatsapp, activo) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (extension_netelip) DO UPDATE SET empleado_id = EXCLUDED.empleado_id, nombre = EXCLUDED.nombre, rol = EXCLUDED.rol,
        whatsapp = EXCLUDED.whatsapp, activo = EXCLUDED.activo, actualizado_en = NOW() RETURNING *`;
    await client.query(upsert, ['101', 'sdr', 'Laura Gómez', 'sdr', '+34600000000', true]);
    const { rows } = await client.query(`SELECT nombre, whatsapp FROM comercial_rol WHERE extension_netelip = '101'`);
    expect(rows).toEqual([{ nombre: 'Laura Gómez', whatsapp: '+34600000000' }]);
  });

  it('llamada_evaluacion: admite una reunión y exige exactamente uno de llamada_id o reunion_id', async () => {
    await client.query(`INSERT INTO llamada_evaluacion (reunion_id, empleado_id, rol, version_rubrica) VALUES ($1,'ernesto','closer_f2','f2-v1')`, [reunionId]);
    await expect(client.query(`INSERT INTO llamada_evaluacion (reunion_id, version_rubrica) VALUES ($1,'f2-v1')`, [reunionId])).rejects.toThrow(/llamada_evaluacion_reunion_rubrica/);
    await expect(client.query(`INSERT INTO llamada_evaluacion (estado) VALUES ('evaluada')`)).rejects.toThrow(/llamada_evaluacion_origen_check/);
    await expect(client.query(`INSERT INTO llamada_evaluacion (llamada_id, reunion_id) VALUES (1, $1)`, [reunionId])).rejects.toThrow(/llamada_evaluacion_origen_check/);
    await expect(client.query(`INSERT INTO llamada_evaluacion (reunion_id) VALUES (999999)`)).rejects.toThrow(/llamada_evaluacion_reunion_fk/);
  });

  it('objecion_marketing: una objeción de reunión va por evaluacion_id; ninguna queda huérfana', async () => {
    const { rows: [ev] } = await client.query(`SELECT id FROM llamada_evaluacion WHERE reunion_id = $1`, [reunionId]);
    await client.query(`INSERT INTO objecion_marketing (evaluacion_id, tipo_objecion, cita) VALUES ($1,'plazo','Me preocupa que la obra se alargue.')`, [ev.id]);
    await expect(client.query(`INSERT INTO objecion_marketing (tipo_objecion, cita) VALUES ('otra','sin origen')`)).rejects.toThrow(/objecion_marketing_origen_check/);
  });

  it('la cola de llamadas de Juan no se para por una reunión pendiente más antigua', async () => {
    await client.query(`UPDATE llamada_evaluacion SET estado = 'pendiente', proximo_intento = NOW() - INTERVAL '1 day' WHERE reunion_id = $1`, [reunionId]);
    expect(await procesarSiguienteEvaluacion(pool, async () => { throw new Error('no debe llamarse'); }, {} as never)).toBeNull();
    // Llega una llamada más reciente, sin transcripción: la cola la coge (y la marca no_evaluada sin llamar al modelo).
    await client.query(`INSERT INTO netelip_calls (agent_extension, direction, duration_seconds) VALUES ('101','outbound',200);
      INSERT INTO llamada_evaluacion (llamada_id, extension_netelip, rol) VALUES (2,'101','sdr')`);
    expect(await procesarSiguienteEvaluacion(pool, async () => { throw new Error('no debe llamarse'); }, {} as never)).toBe('no_evaluada');
    const { rows } = await client.query(`SELECT estado FROM llamada_evaluacion WHERE reunion_id = $1`, [reunionId]);
    expect(rows).toEqual([{ estado: 'pendiente' }]);   // la reunión no la toca: es de nuestro procesador
  });

  it('rubrica_version admite closer_f4, y el SQL de alta de Ernesto de la guía funciona', async () => {
    await client.query(`INSERT INTO rubrica_version (codigo, rol, version, fuente, objetivo, criterios, errores_criticos, activo)
      VALUES ('closer_f4-v1','closer_f4',1,'prueba','Cierre','[]','[]',TRUE)`);
    await expect(client.query(`INSERT INTO rubrica_version (codigo, rol, version, fuente, objetivo, criterios, errores_criticos)
      VALUES ('jefe-v1','jefe',1,'prueba','x','[]','[]')`)).rejects.toThrow(/rubrica_version_rol_check/);
    // La consulta de docs/REUNIONES_MEET_CALIFICADOR.md (alta por SQL), dos veces: la segunda actualiza.
    const alta = `INSERT INTO comercial_rol (empleado_id, nombre, rol)
      SELECT id, nombre, $2 FROM empleados WHERE LOWER(email) = $1 AND activo
      ON CONFLICT (empleado_id) DO UPDATE SET rol = EXCLUDED.rol, activo = TRUE, actualizado_en = NOW()`;
    await client.query(alta, ['ernesto@lyn.example', 'closer_f3']);
    await client.query(alta, ['ernesto@lyn.example', 'closer_f2']);
    expect((await client.query(`SELECT rol, extension_netelip FROM comercial_rol WHERE empleado_id = 'ernesto'`)).rows).toEqual([{ rol: 'closer_f2', extension_netelip: null }]);
  });

  it('el envío por WhatsApp de Juan ignora las evaluaciones de reuniones', async () => {
    await client.query(`UPDATE llamada_evaluacion SET estado = 'evaluada', feedback_texto = 'x', enviado_en = NULL WHERE reunion_id = $1`, [reunionId]);
    await client.query(`UPDATE llamada_evaluacion SET enviado_en = NOW() WHERE llamada_id IS NOT NULL`);
    const enviados: string[] = [];
    const n = await enviarPendientes(pool, async (tel: string) => { enviados.push(tel); }, { envioActivo: true, supervisorNombre: 'Ernesto', supervisorWhatsapp: null } as never);
    expect(n).toBe(0);
    expect(enviados).toEqual([]);
    expect((await client.query(`SELECT envio_intentos, envio_error FROM llamada_evaluacion WHERE reunion_id = $1`, [reunionId])).rows)
      .toEqual([{ envio_intentos: 0, envio_error: null }]);
  });

  it('un empleado repetido en comercial_rol no tumba el arranque: se migra todo menos UNIQUE (empleado_id)', async () => {
    const otro = `${ESQUEMA}_dup`;
    try {
      await client.query(`CREATE SCHEMA ${otro}; SET search_path TO ${otro};
        CREATE TABLE comercial_rol (extension_netelip TEXT PRIMARY KEY, empleado_id TEXT, nombre TEXT NOT NULL,
          rol TEXT NOT NULL CHECK (rol IN ('sdr','closer_f2','closer_f3')), activo BOOLEAN NOT NULL DEFAULT TRUE);
        INSERT INTO comercial_rol VALUES ('101','laura','Laura','sdr'), ('102','laura','Laura (2.ª línea)','sdr');`);
      await expect(adaptarCalificador(pool)).resolves.toBeUndefined();
      const { rows } = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'comercial_rol'::regclass ORDER BY conname`);
      expect(rows.map((r) => r.conname)).toEqual(['comercial_rol_extension_netelip_key', 'comercial_rol_pkey', 'comercial_rol_rol_check']);
    } finally {
      await client.query(`SET search_path TO ${ESQUEMA}; DROP SCHEMA IF EXISTS ${otro} CASCADE`);
    }
  });
});
