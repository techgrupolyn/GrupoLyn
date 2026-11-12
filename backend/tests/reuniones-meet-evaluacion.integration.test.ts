// Evaluación de reuniones de Meet (869fppbcj) de punta a punta, uno por escenario de los criterios de aceptación del
// ticket, sobre las tablas REALES del calificador (ensureCalificador, PR #33) en PostgreSQL QA local. Gemini se
// sustituye por un evaluador falso que guarda lo que recibe; las transcripciones son inventadas.
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCalificador } from '../netelip/calificador/schema.ts';
import { publicarRubrica, RUBRICA_SDR_V1, type DefinicionRubrica } from '../netelip/calificador/rubrica.ts';
import type { Evaluador } from '../netelip/calificador/modelo.ts';
import { ensureReunionesMeet } from '../reuniones-meet/schema.ts';
import { ingestarTranscripciones, vincularPendientes } from '../reuniones-meet/proceso.ts';
import { encolarReuniones, procesarSiguienteReunion } from '../reuniones-meet/evaluacion.ts';
import { reevaluarReuniones } from '../reuniones-meet/reevaluar.ts';
import { vincularLeads } from '../reuniones-meet/lead.ts';
import { conCoste, costePorReunion, informeCoste } from '../reuniones-meet/informe.ts';

const databaseUrl = process.env.QA_TEST_DATABASE_URL;
const ESQUEMA = `reuniones_eval_test_${process.pid}`;
const CONFIG = { supervisorNombre: 'Ernesto', maxCaracteres: 150_000 };

const rubricaCloser = (rol: 'closer_f2' | 'closer_f3', version = 1): DefinicionRubrica =>
  ({ ...RUBRICA_SDR_V1, codigo: `${rol}-v${version}`, rol, version, fuente: 'rúbrica de prueba (no es la de Alex)' });

const VISITA = `F2 · Visita García - Transcripción
Asistentes: Ernesto Pérez, María García
Transcripción
00:00:00

Ernesto Pérez: Buenas tardes, María. Soy Ernesto de Grupo LYN y vengo por la reforma de la cocina.
María García: Hola, pasa. Me preocupa que la obra se alargue meses.
Ernesto Pérez: Lo entiendo. Te dejo dos fechas para la presentación: el martes a las diez o el jueves a las cinco.
00:05:00

María García: El martes. Mi teléfono es 612 345 678 y vivimos en calle Mayor 12
Ernesto Pérez: Perfecto, te escribo hoy con la confirmación.`;

/** Gemini falso: guarda lo que recibe y responde una salida válida para la rúbrica (o falla las primeras `fallos` veces). */
function evaluadorFalso(opciones: { fallos?: number } = {}) {
  const recibidos: Array<{ system: string; user: string }> = [];
  let fallos = opciones.fallos ?? 0;
  const evaluar: Evaluador = async (system, user) => {
    recibidos.push({ system, user });
    if (fallos > 0) { fallos--; throw new Error('Gemini respondió HTTP 503'); }
    const pasos = RUBRICA_SDR_V1.criterios.map((c) => ({ paso: c.paso, aplica: true, puntos: c.paso === 6 ? c.peso - 5 : c.peso, comentario: 'evidencia' }));
    return {
      model: 'gemini-falso', inputTokens: 12_000, outputTokens: 800,
      text: JSON.stringify({ llamada_evaluable: true, motivo_no_evaluable: null, pasos, errores_criticos: [],
        bien: ['Escucha la preocupación del cliente', 'Propone dos fechas concretas'],
        mejorar: [{ que: 'Resumen', accion: 'Resume el alcance antes de proponer' }, { que: 'Decisores', accion: 'Pregunta quién más decide' }],
        duda: { valor: false, motivo: null },
        objeciones: [{ tipo: 'plazo', cita: 'Me preocupa que la obra se alargue meses.', idea_contenido: null }] }),
    };
  };
  return { evaluar, recibidos };
}

describe.skipIf(!databaseUrl)('Evaluación de reuniones de Meet en PostgreSQL QA local', () => {
  let client: Client;
  let pool: Pool;
  let artefactos = 0;

  const nuevaReunion = async (titulo: string, texto: string) => {
    artefactos++;
    const id = `00000000-0000-0000-0000-${String(artefactos).padStart(12, '0')}`;
    await client.query(`INSERT INTO google_drive_artifacts (id, connection_id, folder_id, google_file_id, name, artifact_type, content_text, source_modified_at)
      VALUES ($1,'00000000-0000-0000-0000-00000000c001','00000000-0000-0000-0000-00000000f001',$2,$3,'transcript',$4,'2026-11-10 10:00+00')`, [id, `file-${artefactos}`, titulo, texto]);
    await client.query(`INSERT INTO meeting_artifact_organizers (artifact_id, employee_id, assigned_by) VALUES ($1,'ernesto','calendar:ev${artefactos}')`, [id]);
    return id;
  };
  const ingestarYVincular = async () => { await ingestarTranscripciones(pool); while ((await vincularPendientes(pool)) > 0) { /* siguiente */ } };
  const reunionDe = async (titulo: string) => (await client.query(`SELECT * FROM reunion WHERE titulo = $1`, [titulo])).rows[0];
  const evaluacionesDe = async (reunionId: string) => (await client.query(`SELECT * FROM llamada_evaluacion WHERE reunion_id = $1 ORDER BY id`, [reunionId])).rows;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    const localPort = url.port === '15439' || (process.env.CI === 'true' && url.port === '5432');
    if (url.hostname !== '127.0.0.1' || !localPort || url.pathname !== '/lyn_qa_retest') throw new Error('Solo QA local');
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA ${ESQUEMA}; SET search_path TO ${ESQUEMA};
      CREATE TABLE empleados (id VARCHAR(255) PRIMARY KEY, nombre VARCHAR(255) NOT NULL, apellido VARCHAR(255), email VARCHAR(255), activo BOOLEAN NOT NULL DEFAULT TRUE);
      CREATE TABLE netelip_calls (id BIGSERIAL PRIMARY KEY, agent_extension TEXT);
      CREATE TABLE google_drive_connections (id UUID PRIMARY KEY, revoked_at TIMESTAMPTZ);
      CREATE TABLE google_drive_folders (id UUID PRIMARY KEY, connection_id UUID, enabled BOOLEAN NOT NULL DEFAULT TRUE);
      CREATE TABLE google_drive_artifacts (id UUID PRIMARY KEY, connection_id UUID NOT NULL, folder_id UUID, google_file_id VARCHAR(255) NOT NULL,
        name VARCHAR(1024) NOT NULL, artifact_type VARCHAR(40) NOT NULL, content_text TEXT, source_modified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE meeting_reviews (artifact_id UUID PRIMARY KEY, meeting_date DATE);
      CREATE TABLE meeting_artifact_organizers (artifact_id UUID PRIMARY KEY, employee_id VARCHAR(255) NOT NULL, assigned_by TEXT NOT NULL, assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      INSERT INTO empleados VALUES ('ernesto','Ernesto','Pérez','ernesto@lyn.example',TRUE);
      INSERT INTO google_drive_connections VALUES ('00000000-0000-0000-0000-00000000c001', NULL);
      INSERT INTO google_drive_folders VALUES ('00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-00000000c001',TRUE);`);
    // Un pg.Pool real con el mismo esquema: así se prueba también la transacción con conexión propia.
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${ESQUEMA}` });
    await ensureCalificador(pool);
    await ensureReunionesMeet(pool);
    await client.query(`INSERT INTO comercial_rol (empleado_id, nombre, rol) VALUES ('ernesto','Ernesto','closer_f2')`);
    await publicarRubrica(pool, rubricaCloser('closer_f2'), { activar: true });
  });

  afterAll(async () => {
    await pool?.end();
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
    await client.end();
  });

  it('Reunión con rúbrica activa: se evalúa con esa versión y queda con la reunión y el comercial', async () => {
    await nuevaReunion('F2 · Visita García - Transcripción', VISITA);
    await ingestarYVincular();
    const r = await reunionDe('F2 · Visita García - Transcripción');
    expect(r).toMatchObject({ estado: 'por_evaluar', fase: 'F2', version_rubrica: 'closer_f2-v1' });
    expect(await encolarReuniones(pool)).toBe(1);
    const { evaluar, recibidos } = evaluadorFalso();
    expect(await procesarSiguienteReunion(pool, evaluar, CONFIG)).toBe('evaluada');
    const [ev] = await evaluacionesDe(r.id);
    expect(ev).toMatchObject({ estado: 'evaluada', llamada_id: null, empleado_id: 'ernesto', version_rubrica: 'closer_f2-v1',
      rubrica_version_id: r.rubrica_version_id, nota: 95, apto: true, feedback_texto: null, tokens_entrada: 12_000, tokens_salida: 800, reevaluacion: false });
    expect(ev.puntuacion_pasos).toHaveLength(7);
    expect((await reunionDe('F2 · Visita García - Transcripción')).estado).toBe('evaluada');
    // Objeción con su cita verificada, atada a la evaluación (sin llamada).
    expect((await client.query(`SELECT llamada_id, tipo_objecion, cita FROM objecion_marketing WHERE evaluacion_id = $1`, [ev.id])).rows)
      .toEqual([{ llamada_id: null, tipo_objecion: 'plazo', cita: 'Me preocupa que la obra se alargue meses.' }]);
    // La rúbrica del prompt es la versionada del closer.
    expect(recibidos[0].system).toContain('closer_f2-v1');
  });

  it('Datos personales: el modelo recibe marcadores, no el nombre, el teléfono ni la dirección del cliente', async () => {
    const r = await reunionDe('F2 · Visita García - Transcripción');
    const { evaluar, recibidos } = evaluadorFalso();
    await client.query(`DELETE FROM objecion_marketing WHERE evaluacion_id IN (SELECT id FROM llamada_evaluacion WHERE reunion_id = $1)`, [r.id]);
    await client.query(`UPDATE llamada_evaluacion SET estado = 'pendiente', proximo_intento = NOW() WHERE reunion_id = $1`, [r.id]);
    await procesarSiguienteReunion(pool, evaluar, CONFIG);
    const enviado = recibidos[0].user;
    expect(enviado).not.toMatch(/María|García|612 345 678|calle Mayor/);
    expect(enviado).toContain('[TELÉFONO]');
    expect(enviado).toContain('[DIRECCIÓN]');
    expect(enviado).toMatch(/\[00:00:00\] GRUPO LYN: Buenas tardes, \[NOMBRE\]/);
    expect(enviado).toMatch(/\[00:05:00\] CLIENTE: /);
  });

  it('Evento repetido: el mismo archivo y la misma reunión no duplican ni la reunión ni su evaluación', async () => {
    const r = await reunionDe('F2 · Visita García - Transcripción');
    expect(await ingestarTranscripciones(pool)).toBe(0);
    await client.query(`UPDATE reunion SET estado = 'por_evaluar' WHERE id = $1`, [r.id]);   // como si se volviera a vincular
    expect(await encolarReuniones(pool)).toBe(0);
    expect(await evaluacionesDe(r.id)).toHaveLength(1);
    await client.query(`UPDATE reunion SET estado = 'evaluada' WHERE id = $1`, [r.id]);
  });

  it('Sin rúbrica para el rol: una F3 queda sin_rubrica y no se llama al modelo', async () => {
    await nuevaReunion('F3 · Presentación López - Transcripción', 'Ernesto Pérez: Os presento la propuesta.\nAna López: Vale.\nAna López: Gracias.');
    await ingestarYVincular();
    expect(await reunionDe('F3 · Presentación López - Transcripción')).toMatchObject({ estado: 'sin_rubrica', motivo: 'No hay rúbrica activa para F3.' });
    expect(await encolarReuniones(pool)).toBe(0);
    const { evaluar, recibidos } = evaluadorFalso();
    expect(await procesarSiguienteReunion(pool, evaluar, CONFIG)).toBeNull();
    expect(recibidos).toHaveLength(0);
  });

  it('Sin consentimiento: no se envía al modelo y no entra en la cola', async () => {
    await nuevaReunion('F2 · Visita Ruiz - Transcripción', 'Ernesto Pérez: ¿Os importa que grabemos?\nLuis Ruiz: Prefiero que no se grabe, gracias.\nLuis Ruiz: Empezamos.');
    await ingestarYVincular();
    expect(await reunionDe('F2 · Visita Ruiz - Transcripción')).toMatchObject({ estado: 'sin_consentimiento' });
    expect(await encolarReuniones(pool)).toBe(0);
  });

  it('Rúbrica activada después: 12 reuniones F3 sin_rubrica quedan evaluadas con esa versión tras reevaluar', async () => {
    for (let i = 1; i <= 11; i++) await nuevaReunion(`F3 · Presentación ${i} - Transcripción`, `Ernesto Pérez: Os presento la propuesta ${i}.\nCliente ${i} Pérez: Me preocupa que la obra se alargue meses.\nCliente ${i} Pérez: Gracias.`);
    await ingestarYVincular();
    expect((await client.query(`SELECT COUNT(*)::int AS n FROM reunion WHERE fase = 'F3' AND estado = 'sin_rubrica'`)).rows[0].n).toBe(12);
    const f3 = await publicarRubrica(pool, rubricaCloser('closer_f3'), { activar: true });
    const res = await reevaluarReuniones(pool, { codigo: 'closer_f3-v1' });
    expect(res).toMatchObject({ fase: 'F3', activa: true, sin_rubrica: 12, reabiertas: 12, por_evaluar: 12, reevaluaciones_creadas: 0 });
    expect(await encolarReuniones(pool)).toBe(12);
    const { evaluar } = evaluadorFalso();
    let n = 0;
    while (await procesarSiguienteReunion(pool, evaluar, CONFIG)) n++;
    expect(n).toBe(12);
    const { rows } = await client.query(`SELECT e.estado, e.rubrica_version_id::text AS v FROM llamada_evaluacion e JOIN reunion r ON r.id = e.reunion_id WHERE r.fase = 'F3'`);
    expect(rows).toHaveLength(12);
    expect(rows.every((x) => x.estado === 'evaluada' && x.v === f3.id)).toBe(true);
  });

  it('Rúbrica nueva sobre reuniones ya evaluadas: evaluación nueva sin tocar la anterior; la negativa a grabar no entra', async () => {
    await publicarRubrica(pool, rubricaCloser('closer_f2', 2), { activar: true });
    const res = await reevaluarReuniones(pool, { codigo: 'closer_f2-v2' });
    expect(res).toMatchObject({ fase: 'F2', reevaluaciones_creadas: 1 });   // la visita García; la de Ruiz (sin consentimiento) no
    const { evaluar } = evaluadorFalso();
    expect(await procesarSiguienteReunion(pool, evaluar, CONFIG)).toBe('evaluada');
    const r = await reunionDe('F2 · Visita García - Transcripción');
    const evs = await evaluacionesDe(r.id);
    expect(evs.map((e) => [e.version_rubrica, e.reevaluacion, e.estado])).toEqual([['closer_f2-v1', false, 'evaluada'], ['closer_f2-v2', true, 'evaluada']]);
  });

  it('Formato real de Meet: cuentas de empresa como GRUPO LYN y el cliente invitado enmascarado aunque solo se mencione', async () => {
    const titulo = 'F2 · Visita Ruiz (9 nov 2026 a las 10:25 GMT-05:00) - Transcripción';
    await nuevaReunion(titulo, `${titulo}
00:00:01

Tech Grupo LYN: Buenas, ¿empezamos con la visita?
Interiorista Lyn 15: Sí. Marta Ruiz me dijo que me preocupa que la obra se alargue meses.


00:00:09

Tech Grupo LYN: Te propongo el martes a las diez para la presentación.
Interiorista Lyn 15: Perfecto, se lo paso.


La transcripción finalizó después de 00:11:26

Esta transcripción editable se generó por computadora y puede contener errores.`);
    await ingestarYVincular();
    const r = await reunionDe(titulo);
    await client.query(`UPDATE reunion SET invitados = $2::jsonb WHERE id = $1`,
      [r.id, JSON.stringify([{ email: 'marta@example.com', nombre: 'Marta Ruiz', interno: false }])]);
    await encolarReuniones(pool);
    const { evaluar, recibidos } = evaluadorFalso();
    expect(await procesarSiguienteReunion(pool, evaluar, CONFIG)).toBe('evaluada');
    const enviado = recibidos[0].user;
    expect(enviado).not.toMatch(/Marta|Ruiz|Tech Grupo|Interiorista|finalizó|editable/);
    expect(enviado.split(/\r?\n/).filter((l) => l.startsWith('[')).every((l) => /\] GRUPO LYN: /.test(l))).toBe(true);
    expect(enviado).toContain('11 min');   // duración exacta del pie: 00:11:26
  });

  it('Fase desde el CRM: sin fase en el título, la etapa e4 del lead la hace F2 y se evalúa', async () => {
    const titulo = 'Reunión del 10 nov 2026 a las 17:00 GMT+01:00 - Transcripción';
    await nuevaReunion(titulo, 'Ernesto Pérez: Os enseño la distribución.\nLaura Gil: Me preocupa que la obra se alargue meses.\nLaura Gil: Gracias.');
    await ingestarYVincular();
    expect(await reunionDe(titulo)).toMatchObject({ estado: 'sin_rubrica', fase: null, motivo: 'Sin fase: ni el título ni la etapa del lead en el CRM la indican.' });
    const r = await reunionDe(titulo);
    await client.query(`UPDATE reunion SET invitados = $2::jsonb, invitados_en = NOW() WHERE id = $1`,
      [r.id, JSON.stringify([{ email: 'laura@example.com', nombre: 'Laura Gil', interno: false }])]);
    const pedidos: string[][] = [];
    const buscarLead = async (emails: string[]) => { pedidos.push(emails); return [{ id: '86laura', etapa: 'e4 VISITA' }]; };
    expect(await vincularLeads(pool, buscarLead)).toBeGreaterThanOrEqual(1);
    expect(pedidos).toContainEqual(['laura@example.com']);
    expect(await reunionDe(titulo)).toMatchObject({ lead_estado: 'vinculado', lead_id: '86laura', lead_etapa: 'e4 VISITA', estado: 'pendiente' });
    await ingestarYVincular();
    expect(await reunionDe(titulo)).toMatchObject({ estado: 'por_evaluar', fase: 'F2', fase_origen: 'crm', version_rubrica: 'closer_f2-v2' });
    await encolarReuniones(pool);
    const { evaluar } = evaluadorFalso();
    expect(await procesarSiguienteReunion(pool, evaluar, CONFIG)).toBe('evaluada');
  });

  it('El modelo falla: reintenta y, a la tercera, la reunión queda en error sin perder nada', async () => {
    await nuevaReunion('F2 · Visita Falla - Transcripción', 'Ernesto Pérez: Buenas.\nEva Sanz: Hola, me preocupa que la obra se alargue meses.\nEva Sanz: Gracias.');
    await ingestarYVincular();
    await encolarReuniones(pool);
    const { evaluar } = evaluadorFalso({ fallos: 3 });
    for (let i = 0; i < 2; i++) {
      expect(await procesarSiguienteReunion(pool, evaluar, CONFIG)).toBe('reintento');
      await client.query(`UPDATE llamada_evaluacion SET proximo_intento = NOW() WHERE estado = 'pendiente'`);
    }
    expect(await procesarSiguienteReunion(pool, evaluar, CONFIG)).toBe('error');
    expect(await reunionDe('F2 · Visita Falla - Transcripción')).toMatchObject({ estado: 'error' });
  });

  it('Coste: tokens por reunión e informe, con y sin precio configurado', async () => {
    const filas = await costePorReunion(pool);
    expect(filas.length).toBe(16);   // 12 F3 + visita García (v1 y v2) + visita Ruiz + la de fase por CRM
    const conPrecio = conCoste(filas, { entradaPorMillon: 0.5, salidaPorMillon: 3 });
    expect(conPrecio[0].coste).toBe(0.0084);   // 12.000 × 0,5 + 800 × 3 = 8.400 por millón
    const informe = informeCoste(conPrecio, { entradaPorMillon: 0.5, salidaPorMillon: 3 }, '2026-11-12');
    expect(informe).toContain('Media por reunión: 12800 tokens');
    expect(informeCoste(filas, { entradaPorMillon: null, salidaPorMillon: null }, '2026-11-12')).toContain('sin precio configurado');
  });
});
