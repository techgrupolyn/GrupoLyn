// Evaluación de una reunión de Meet con GEMINI REAL (869fppbcj). Solo se ejecuta a propósito:
//   QA_LIVE_REUNIONES_GEMINI=true GOOGLE_GEMINI_API_KEY=… QA_TEST_DATABASE_URL=postgres://…@127.0.0.1:15439/lyn_qa_retest \
//     npx vitest run tests/reuniones-meet-gemini.live.test.ts
// Datos 100 % inventados (reunión, nombres, teléfono y dirección). Base local de QA en un esquema propio que se borra.
// La rúbrica es de PRUEBA, sacada del Manual Fase 0 (qué pasa en la reunión de oficina): no es la de Alex.
// Solo permite conexiones a la API de Gemini; cualquier otra hace fallar la prueba.
import 'dotenv/config';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCalificador } from '../netelip/calificador/schema.ts';
import { evaluadorGemini } from '../netelip/calificador/modelo.ts';
import { publicarRubrica, validarDefinicion } from '../netelip/calificador/rubrica.ts';
import { citaVerificable } from '../netelip/calificador/reglas.ts';
import { ensureReunionesMeet } from '../reuniones-meet/schema.ts';
import { ingestarTranscripciones, vincularPendientes } from '../reuniones-meet/proceso.ts';
import { configReunionesDesdeEnv, encolarReuniones, procesarSiguienteReunion } from '../reuniones-meet/evaluacion.ts';
import { prepararTranscripcion } from '../reuniones-meet/transcripcion.ts';
import { conCoste, costePorReunion, informeCoste, preciosDesdeEnv } from '../reuniones-meet/informe.ts';

const ACTIVO = process.env.QA_LIVE_REUNIONES_GEMINI === 'true';
const ESQUEMA = `reuniones_gemini_live_${process.pid}`;

/** Rúbrica de prueba de F2 (reunión de oficina) a partir del Manual Fase 0 (F0-MC-02 v2.0, Paso 4 y Parte III). */
const RUBRICA_F2_PRUEBA = validarDefinicion({
  codigo: 'closer_f2-v1', rol: 'closer_f2', version: 1, nota_apto: 80,
  fuente: 'PRUEBA · borrador desde el Manual Fase 0 (reunión de oficina). No es la rúbrica de Alex.',
  objetivo: 'Primera reunión de oficina con el cliente (unas dos horas): entender necesidades y rutinas, trabajar sobre el plano una primera distribución, explicar el proceso de Grupo LYN y dar un primer marco de inversión, y cerrar el siguiente paso.',
  criterios: [
    { nombre: 'Necesidades y rutinas', peso: 25, descripcion: 'Entiende qué quiere conseguir el cliente, cómo vive y qué le preocupa; deja hablar y resume con sus palabras.' },
    { nombre: 'Distribución sobre plano', peso: 25, descripcion: 'Trabaja con el cliente una primera propuesta de distribución, explicando implicaciones sin imponer una solución.' },
    { nombre: 'Proceso de Grupo LYN', peso: 15, descripcion: 'Explica cómo trabaja Grupo LYN (anteproyecto, renders, presupuesto cerrado después) y resuelve dudas sin sobreexplicar.' },
    { nombre: 'Marco de inversión', peso: 20, descripcion: 'Da un primer marco de inversión según el alcance, como referencia y no como precio cerrado, y escucha la reacción.' },
    { nombre: 'Siguiente paso', peso: 15, descripcion: 'Cierra con una acción concreta, responsable, fecha y hora.' },
  ],
  errores_criticos: [
    { codigo: 'REGLA_CERO', nombre: 'REGLA CERO', descripcion: 'Termina sin siguiente acción con responsable, fecha y hora («me dices», «ya hablamos»).' },
    { codigo: 'LIMITE_PROFESIONAL', nombre: 'LÍMITE PROFESIONAL', descripcion: 'Confirma estructura, licencia, viabilidad o plazo de obra sin revisión técnica.' },
    { codigo: 'PRECIO_CERRADO', nombre: 'PRECIO CERRADO', descripcion: 'Da un precio exacto o final antes del anteproyecto. En la reunión de oficina solo se da un marco de inversión.' },
  ],
  reglas: ['El aviso de grabación no se penaliza.', 'Evalúa la función de cada paso, no las palabras literales.'],
});

// Reunión inventada con el formato REAL de Meet (título, marcas, pie). Incluye a propósito un precio cerrado.
const TITULO = 'F2 · Reunión de oficina Ruiz (12 nov 2026 a las 10:00 GMT+01:00) - Transcripción';
const TRANSCRIPCION = `${TITULO}
00:00:02

Ernesto Pérez: Buenos días, Marta. Gracias por venir a la oficina. Antes de enseñaros nada, contadme cómo vivís ahora la casa y qué os gustaría cambiar.
Marta Ruiz: Somos cuatro y la cocina se nos queda pequeña. Queremos abrirla al salón y ganar un baño.
Ernesto Pérez: Entiendo: lo que más os pesa es el día a día en la cocina y tener un segundo baño para los niños, ¿es así?
Marta Ruiz: Exacto. Y me preocupa que la obra se alargue meses.


00:12:40

Ernesto Pérez: Mirad el plano. Si abrimos aquí la cocina, el pasillo se queda en un metro diez y podemos sacar el baño junto a la habitación pequeña. Ese muro habría que revisarlo con el técnico antes de decidir.
Marta Ruiz: Me gusta. Vivimos en la calle Mayor 12, por si lo necesitáis para la visita. Mi móvil es 612 345 678.
Ernesto Pérez: Perfecto. Sobre cómo trabajamos: ahora haríamos el anteproyecto con renders y realidad virtual, y con eso el presupuesto detallado.


00:31:15

Marta Ruiz: ¿Y más o menos cuánto sería?
Ernesto Pérez: Para lo que hemos visto, os lo dejo cerrado en 72.000 euros, ese es el precio final.
Marta Ruiz: Vale, lo tenemos que pensar.
Ernesto Pérez: Claro. ¿Os parece que os llame el jueves a las once para ver si seguimos con el anteproyecto?
Marta Ruiz: Sí, el jueves a las once.


La transcripción finalizó después de 00:41:05

Esta transcripción editable se generó por computadora y puede contener errores.`;

describe.skipIf(!ACTIVO)('Reunión de Meet evaluada con Gemini real (datos inventados)', () => {
  let client: Client;
  let pool: Pool;
  const enviados: string[] = [];
  let fetchOriginal: typeof fetch;

  beforeAll(async () => {
    const databaseUrl = process.env.QA_TEST_DATABASE_URL || '';
    const url = new URL(databaseUrl);
    if (url.hostname !== '127.0.0.1' || url.port !== '15439' || url.pathname !== '/lyn_qa_retest') throw new Error('Solo la base local de QA (127.0.0.1:15439/lyn_qa_retest)');
    if (!process.env.GOOGLE_GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) throw new Error('Falta GOOGLE_GEMINI_API_KEY');
    // Solo Gemini: guarda lo que se envía para comprobar que no lleva datos personales.
    fetchOriginal = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
      const destino = new URL(input instanceof Request ? input.url : String(input));
      if (destino.origin !== 'https://generativelanguage.googleapis.com') throw new Error(`La prueba solo permite Gemini, no ${destino.origin}`);
      enviados.push(String(options?.body ?? ''));
      return fetchOriginal(input, options);
    };
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
      INSERT INTO empleados VALUES ('ernesto','Ernesto','Pérez','ernesto@example.com',TRUE);
      INSERT INTO google_drive_connections VALUES ('00000000-0000-0000-0000-00000000c001', NULL);
      INSERT INTO google_drive_folders VALUES ('00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-00000000c001',TRUE);`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${ESQUEMA}` });
    await ensureCalificador(pool);
    await ensureReunionesMeet(pool);
    await client.query(`INSERT INTO comercial_rol (empleado_id, nombre, rol) VALUES ('ernesto','Ernesto','closer_f2')`);
    await publicarRubrica(pool, RUBRICA_F2_PRUEBA, { activar: true });
    await client.query(`INSERT INTO google_drive_artifacts (id, connection_id, folder_id, google_file_id, name, artifact_type, content_text, source_modified_at)
      VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000c001','00000000-0000-0000-0000-00000000f001','file-live',$1,'transcript',$2,'2026-11-12 10:45+01')`,
      [TITULO, TRANSCRIPCION]);
    await client.query(`INSERT INTO meeting_artifact_organizers VALUES ('00000000-0000-0000-0000-0000000000a1','ernesto','calendar:prueba',NOW())`);
  });

  afterAll(async () => {
    if (fetchOriginal) globalThis.fetch = fetchOriginal;
    await pool?.end();
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
    await client.end();
  });

  it('evalúa la reunión con la rúbrica de prueba: salida válida, citas verificadas, sin datos personales y con coste', async () => {
    await ingestarTranscripciones(pool);
    while ((await vincularPendientes(pool)) > 0) { /* siguiente */ }
    const { rows: [reunion] } = await client.query(`SELECT id, estado, fase, version_rubrica FROM reunion`);
    expect(reunion).toMatchObject({ estado: 'por_evaluar', fase: 'F2', version_rubrica: 'closer_f2-v1' });
    // El invitado externo (la clienta) se conoce por Calendar: su nombre se enmascara aunque Meet ya lo trae como hablante.
    await client.query(`UPDATE reunion SET invitados = '[{"email":"marta@example.com","nombre":"Marta Ruiz","interno":false}]'::jsonb`);
    expect(await encolarReuniones(pool)).toBe(1);

    const evaluar = evaluadorGemini(process.env)!;
    const resultado = await procesarSiguienteReunion(pool, evaluar, configReunionesDesdeEnv(process.env));
    expect(resultado).toBe('evaluada');

    // Lo que viajó a Gemini no lleva el nombre, el teléfono ni la dirección de la clienta.
    const enviado = enviados.join('\n');
    expect(enviado).not.toMatch(/Marta|Ruiz|612 345 678|calle Mayor/);
    expect(enviado).toContain('GRUPO LYN');

    const { rows: [ev] } = await client.query(`SELECT * FROM llamada_evaluacion WHERE reunion_id = $1`, [reunion.id]);
    expect(ev).toMatchObject({ estado: 'evaluada', version_rubrica: 'closer_f2-v1', llamada_id: null });
    expect(ev.puntuacion_pasos).toHaveLength(5);
    // Cada error crítico que quedó tiene su cita verificada en la transcripción enmascarada.
    const preparada = prepararTranscripcion(TRANSCRIPCION, ['Ernesto Pérez'], { nombresCliente: ['Marta Ruiz'] }).transcripcion;
    for (const e of ev.errores_criticos as Array<{ regla: string; cita: string }>) expect(citaVerificable(e.cita, preparada)).toBe(true);
    const reglas = (ev.errores_criticos as Array<{ regla: string }>).map((e) => e.regla);

    const filas = conCoste(await costePorReunion(pool), preciosDesdeEnv(process.env));
    console.log(JSON.stringify({
      prueba: 'reuniones-meet-gemini.live', modelo: ev.modelo, nota: ev.nota, apto: ev.apto, escalado: ev.escalado, duda: ev.duda,
      errores_criticos: reglas, descartados: (ev.errores_descartados as unknown[]).length, pasos: ev.puntuacion_pasos,
      tokens: { entrada: ev.tokens_entrada, salida: ev.tokens_salida }, coste: filas[0]?.coste ?? '(sin precio configurado)',
    }, null, 2));
    console.log(informeCoste(filas, preciosDesdeEnv(process.env), new Date().toISOString().slice(0, 10)));
    // La reunión promete «precio final» antes del anteproyecto: lo esperado es PRECIO_CERRADO y, por tanto, no apto.
    expect(reglas, 'Gemini no marcó PRECIO_CERRADO: revisar la rúbrica de prueba o el prompt').toContain('PRECIO_CERRADO');
    expect(ev.apto).toBe(false);
  }, 180_000);
});
