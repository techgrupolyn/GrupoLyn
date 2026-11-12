// Reuniones de Meet de los closers (869fppbcj): reglas puras y decisión de estado, sin base de datos.
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { codigoMeet, duracionAproximada, faseDelTitulo, niegaGrabacion } from '../reuniones-meet/reglas.ts';
import { decidirVinculacion, ingestarTranscripciones, reabrirSinRubrica, vincularPendientes } from '../reuniones-meet/proceso.ts';

type Respuesta = { rows: unknown[]; rowCount?: number };

/** Pool falso: responde según la primera consulta cuyo patrón coincida y guarda lo que se le pidió. */
function poolFalso(respuestas: Array<[RegExp, Respuesta | ((params: unknown[]) => Respuesta)]>) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      const encontrada = respuestas.find(([patron]) => patron.test(sql));
      if (!encontrada) return { rows: [], rowCount: 0 };
      const r = typeof encontrada[1] === 'function' ? encontrada[1](params) : encontrada[1];
      return { rowCount: r.rows.length, ...r };
    },
  } as unknown as Pool;
  return { pool, consultas };
}

const ORGANIZADOR = /FROM meeting_artifact_organizers o JOIN empleados/;
const COMERCIAL = /FROM comercial_rol WHERE empleado_id/;
const EXISTE_RUBRICA = /to_regclass\('rubrica_version'\)/;
const VERSION_ACTIVA = /FROM rubrica_version WHERE activo/;

const ernesto = { employee_id: 'emp-ernesto', email: 'Ernesto@GrupoLyn.com', activo: true };
const reunion = (over: Partial<{ titulo: string; content_text: string | null }> = {}) => ({
  id: '1', artifact_id: 'art-1', estado: 'pendiente' as const,
  titulo: 'F2 · Visita García (abc-defg-hij) - Transcripción',
  content_text: '00:00:05 Ernesto: Buenas, ¿os parece bien que grabemos la reunión?\n00:00:09 Cliente: Sí, claro.\n00:47:30 Ernesto: Hasta el jueves.',
  ...over,
});

describe('Reuniones Meet · reglas', () => {
  it('la fase sale del título: F2/F-3/Fase 4 y las palabras visita y presentación', () => {
    expect(faseDelTitulo('F2 · Visita García')).toBe('F2');
    expect(faseDelTitulo('Reunión F-3 con Pérez')).toBe('F3');
    expect(faseDelTitulo('Fase 4 - cierre Dana')).toBe('F4');
    expect(faseDelTitulo('Presentación de conceptos · López')).toBe('F3');
    expect(faseDelTitulo('Visita técnica')).toBe('F2');
  });

  it('sin fase o con dos fases distintas en el título no se supone ninguna', () => {
    expect(faseDelTitulo('Reunión con García')).toBeNull();
    expect(faseDelTitulo('F2 y F3 · García')).toBeNull();
    expect(faseDelTitulo('Visita y presentación')).toBeNull();
    expect(faseDelTitulo(null)).toBeNull();
  });

  it('detecta la negativa a grabar y no confunde el permiso concedido', () => {
    expect(niegaGrabacion('Cliente: Preferiría... no, prefiero que no se grabe, gracias.')).toBe(true);
    expect(niegaGrabacion('CLIENTE: No quiero que me grabéis.')).toBe(true);
    expect(niegaGrabacion('Cliente: no autorizo la grabación')).toBe(true);
    expect(niegaGrabacion('Cliente: Sin grabar, por favor.')).toBe(true);
    expect(niegaGrabacion('Ernesto: ¿Os parece bien que grabemos? Cliente: Sí, graba sin problema.')).toBe(false);
    expect(niegaGrabacion(null)).toBe(false);
  });

  it('código Meet único y duración aproximada por la mayor marca de tiempo', () => {
    expect(codigoMeet('Visita (abc-defg-hij)', 'texto')).toBe('abc-defg-hij');
    expect(codigoMeet('abc-defg-hij', 'xyz-wxyz-uvw')).toBeNull();
    expect(duracionAproximada('00:00:05 hola\n00:47:30 adiós\n12:10 medio')).toBe(47 * 60 + 30);
    expect(duracionAproximada('sin marcas')).toBeNull();
  });
});

describe('Reuniones Meet · estado de cada reunión (criterios del ticket)', () => {
  it('sin rúbrica para el rol: queda sin_rubrica y no se consulta ningún modelo', async () => {
    const { pool } = poolFalso([[ORGANIZADOR, { rows: [ernesto] }], [COMERCIAL, { rows: [{ rol: 'closer_f2' }] }], [EXISTE_RUBRICA, { rows: [{ existe: false, con_fase: false }] }]]);
    const v = await decidirVinculacion(pool, reunion());
    expect(v).toMatchObject({ estado: 'sin_rubrica', fase: 'F2', fase_origen: 'titulo', rol: 'closer_f2', empleado_id: 'emp-ernesto', organizador_email: 'ernesto@grupolyn.com', version_rubrica: null });
    expect(v.motivo).toBe('No hay rúbrica activa para F2.');
  });

  it('con rúbrica activa para su fase: por_evaluar con esa versión', async () => {
    const { pool, consultas } = poolFalso([[ORGANIZADOR, { rows: [ernesto] }], [COMERCIAL, { rows: [{ rol: 'closer_f2' }] }],
      [EXISTE_RUBRICA, { rows: [{ existe: true, con_fase: true }] }], [VERSION_ACTIVA, { rows: [{ id: '7', version: 'f2-v1' }] }]]);
    const v = await decidirVinculacion(pool, reunion());
    expect(v).toMatchObject({ estado: 'por_evaluar', version_rubrica: 'f2-v1', rubrica_version_id: '7', fase: 'F2' });
    expect(consultas.find((c) => VERSION_ACTIVA.test(c.sql))?.params).toEqual(['F2']);
  });

  it('organizador desconocido: sin_comercial', async () => {
    const { pool } = poolFalso([[ORGANIZADOR, { rows: [] }]]);
    expect(await decidirVinculacion(pool, reunion())).toMatchObject({ estado: 'sin_comercial', empleado_id: null });
  });

  it('organizador que no está en comercial_rol: sin_comercial, pero se guarda quién organizó', async () => {
    const { pool } = poolFalso([[ORGANIZADOR, { rows: [ernesto] }], [COMERCIAL, { rows: [] }]]);
    expect(await decidirVinculacion(pool, reunion())).toMatchObject({
      estado: 'sin_comercial', empleado_id: 'emp-ernesto', motivo: 'El organizador no está dado de alta como comercial.',
    });
  });

  it('sin consentimiento: queda sin_consentimiento aunque el organizador sea comercial', async () => {
    const { pool, consultas } = poolFalso([[ORGANIZADOR, { rows: [ernesto] }], [COMERCIAL, { rows: [{ rol: 'closer_f2' }] }]]);
    const v = await decidirVinculacion(pool, reunion({ content_text: '00:00:05 Cliente: Prefiero que no se grabe.' }));
    expect(v.estado).toBe('sin_consentimiento');
    expect(consultas.some((c) => EXISTE_RUBRICA.test(c.sql))).toBe(false);
  });

  it('sin fase en el título: sin_rubrica con el motivo', async () => {
    const { pool } = poolFalso([[ORGANIZADOR, { rows: [ernesto] }], [COMERCIAL, { rows: [{ rol: 'closer_f3' }] }]]);
    expect(await decidirVinculacion(pool, reunion({ titulo: 'Reunión García' }))).toMatchObject({ estado: 'sin_rubrica', fase: null });
  });

  it('rubrica_version sin las columnas esperadas no rompe: sin_rubrica', async () => {
    const { pool } = poolFalso([[ORGANIZADOR, { rows: [ernesto] }], [COMERCIAL, { rows: [{ rol: 'closer_f2' }] }],
      [EXISTE_RUBRICA, { rows: [{ existe: true, con_fase: true }] }], [VERSION_ACTIVA, () => { throw new Error('column "version" does not exist'); }]]);
    expect(await decidirVinculacion(pool, reunion())).toMatchObject({ estado: 'sin_rubrica' });
  });
});

describe('Reuniones Meet · ingesta y vinculación', () => {
  it('ingesta idempotente: solo transcripciones con texto, una por archivo, ON CONFLICT DO NOTHING', async () => {
    const { pool, consultas } = poolFalso([[/INSERT INTO reunion/, { rows: [], rowCount: 3 }]]);
    expect(await ingestarTranscripciones(pool, 10)).toBe(3);
    const sql = consultas[0].sql;
    expect(sql).toContain("a.artifact_type = 'transcript'");
    expect(sql).toContain('DISTINCT ON (a.google_file_id)');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(sql).toContain('c.revoked_at IS NULL');
    expect(consultas[0].params).toEqual([10]);
  });

  it('la vinculación solo actualiza si el estado no cambió mientras tanto y guarda código Meet y duración', async () => {
    const { pool, consultas } = poolFalso([
      [/SELECT r.id, r.artifact_id/, { rows: [reunion()] }],
      [ORGANIZADOR, { rows: [ernesto] }], [COMERCIAL, { rows: [{ rol: 'closer_f2' }] }], [EXISTE_RUBRICA, { rows: [{ existe: false, con_fase: false }] }],
      [/UPDATE reunion SET estado = \$3/, { rows: [], rowCount: 1 }],
    ]);
    expect(await vincularPendientes(pool)).toBe(1);
    const update = consultas.find((c) => /UPDATE reunion SET estado = \$3/.test(c.sql))!;
    expect(update.sql).toContain('WHERE id = $1 AND estado = $2');
    expect(update.params.slice(0, 3)).toEqual(['1', 'pendiente', 'sin_rubrica']);
    expect(update.params[10]).toBe('abc-defg-hij');
    expect(update.params[11]).toBe(47 * 60 + 30);
  });

  it('un fallo al vincular deja la reunión en error con el motivo, sin parar el lote', async () => {
    const { pool, consultas } = poolFalso([
      [/SELECT r.id, r.artifact_id/, { rows: [reunion()] }],
      [ORGANIZADOR, () => { throw new Error('conexión perdida'); }],
      [/UPDATE reunion SET estado = \$3/, { rows: [], rowCount: 1 }],
    ]);
    await vincularPendientes(pool);
    const update = consultas.find((c) => /UPDATE reunion SET estado = \$3/.test(c.sql))!;
    expect(update.params[2]).toBe('error');
    expect(update.params[3]).toBe('No se pudo vincular: conexión perdida');
  });

  it('reabrir sin_rubrica de una fase no toca sin_consentimiento', async () => {
    const { pool, consultas } = poolFalso([[/UPDATE reunion SET estado = 'pendiente'/, { rows: [], rowCount: 12 }]]);
    expect(await reabrirSinRubrica(pool, 'F2')).toBe(12);
    expect(consultas[0].sql).toContain("WHERE estado = 'sin_rubrica'");
    expect(consultas[0].params).toEqual(['F2']);
  });
});
