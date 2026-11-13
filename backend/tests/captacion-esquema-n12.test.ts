import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureCaptacion } from '../netelip/captacion/schema.ts';
import { abrirBaseAislada, hayBaseDePruebas, type BaseAislada } from './helpers/captacion-base.ts';
import { AGREGACION_V1, MATRIZ_V1 } from '../netelip/captacion/matriz.ts';

const BAJADA = readFileSync(new URL('../netelip/captacion/schema-down.sql', import.meta.url), 'utf8');

let db: BaseAislada;
beforeEach(async () => {
  db = await abrirBaseAislada();
  await ensureCaptacion(db);
});
afterEach(async () => {
  await db.cerrar();
});

const tablas = async (): Promise<string[]> => {
  const { rows } = await db.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1");
  return rows.map((r) => r.t);
};

const insertar = (tabla: string, valores: Record<string, unknown>) => {
  const cols = Object.keys(valores);
  return db.query(
    `INSERT INTO ${tabla} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    Object.values(valores),
  );
};
const evaluacion = (extra: Record<string, unknown> = {}) =>
  insertar('lead_criterio_evaluacion', {
    clickup_task_id: 'task-1', criterio_id: 'decisor', nivel: 'A', origen: 'llamada',
    cita: 'Decidimos mi pareja y yo', marca_tiempo: '00:01:40', interaccion_id: 'call-1',
    fecha_interaccion: '2026-11-10T10:00:00Z', ...extra,
  });
const noApto = (extra: Record<string, unknown> = {}) =>
  insertar('lead_no_apto_evento', {
    clickup_task_id: 'task-1', valor: true, cita: 'No llegamos a más de veinte mil euros', interaccion_id: 'call-1',
    fecha_interaccion: '2026-11-10T10:00:00Z', registrado_por: 'ia', ...extra,
  });

describe.skipIf(!hayBaseDePruebas)('esquema 002_lead_criterios · configuración', () => {
  it('siembra la matriz con los mismos pesos, etiquetas y descriptores que usa el motor', async () => {
    const { rows } = await db.query<Record<string, string | number>>(
      'SELECT criterio_id, etiqueta, nombre, peso, descriptor_a, descriptor_b, descriptor_c, descriptor_d, orden FROM criterio_config WHERE version = 1 ORDER BY orden',
    );
    expect(rows.map((r) => [r.criterio_id, r.nombre, r.etiqueta, r.peso, r.descriptor_a, r.descriptor_b, r.descriptor_c, r.descriptor_d, r.orden])).toEqual(
      MATRIZ_V1.map((c) => [c.criterioId, c.nombre, c.etiqueta, c.peso, c.descriptores.A, c.descriptores.B, c.descriptores.C, c.descriptores.D, c.orden]),
    );
    expect(rows.reduce((n, r) => n + Number(r.peso), 0)).toBe(100);
  });

  it('siembra la agregación con los valores del motor', async () => {
    const { rows } = await db.query<Record<string, string | number>>(
      'SELECT puntos_a, puntos_b, puntos_c, puntos_d, corte_a::text, corte_b::text, corte_c::text, cobertura_minima::text, umbral_a_plus::text FROM agregacion_config WHERE version = 1',
    );
    const r = rows[0] as Record<string, string | number>;
    expect([r.puntos_a, r.puntos_b, r.puntos_c, r.puntos_d]).toEqual([AGREGACION_V1.puntos.A, AGREGACION_V1.puntos.B, AGREGACION_V1.puntos.C, AGREGACION_V1.puntos.D]);
    expect([Number(r.corte_a), Number(r.corte_b), Number(r.corte_c)]).toEqual([AGREGACION_V1.corteA, AGREGACION_V1.corteB, AGREGACION_V1.corteC]);
    expect(Number(r.cobertura_minima)).toBe(AGREGACION_V1.coberturaMinima);
    expect(Number(r.umbral_a_plus)).toBe(AGREGACION_V1.umbralAPlus);
  });

  it('es idempotente: aplicarlo otra vez no falla ni duplica la configuración', async () => {
    await ensureCaptacion(db);
    const a = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM criterio_config');
    const b = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM agregacion_config');
    expect([a.rows[0]?.n, b.rows[0]?.n]).toEqual([7, 1]);
  });

  it('rechaza un criterio que no existe, un peso fuera de 0 a 100 y cortes desordenados', async () => {
    const criterio = (extra: Record<string, unknown>) =>
      insertar('criterio_config', { criterio_id: 'decisor', version: 2, nombre: 'x', etiqueta: 'x', peso: 10, descriptor_a: 'a', descriptor_b: 'b', descriptor_c: 'c', descriptor_d: 'd', orden: 3, ...extra }).catch((e) => { throw e; });
    // criterio_config no tiene columna id: se inserta sin RETURNING.
    const sinRetorno = (extra: Record<string, unknown>) => {
      const v = { criterio_id: 'decisor', version: 2, nombre: 'x', etiqueta: 'x', peso: 10, descriptor_a: 'a', descriptor_b: 'b', descriptor_c: 'c', descriptor_d: 'd', orden: 3, ...extra };
      const cols = Object.keys(v);
      return db.query(`INSERT INTO criterio_config (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(v));
    };
    void criterio;
    await expect(sinRetorno({ criterio_id: 'otro' })).rejects.toThrow(/criterio_config_id_ck/);
    await expect(sinRetorno({ peso: 101 })).rejects.toThrow(/criterio_config_peso_ck/);
    await expect(sinRetorno({ peso: -1 })).rejects.toThrow(/criterio_config_peso_ck/);
    await expect(db.query('INSERT INTO agregacion_config (version, puntos_a, puntos_b, puntos_c, puntos_d, corte_a, corte_b, corte_c, cobertura_minima, umbral_a_plus) VALUES (2,4,3,2,1,2.5,3.5,1.5,0.5,100000)'))
      .rejects.toThrow(/agregacion_config_cortes_ck/);
    await expect(db.query('INSERT INTO agregacion_config (version, puntos_a, puntos_b, puntos_c, puntos_d, corte_a, corte_b, corte_c, cobertura_minima, umbral_a_plus) VALUES (3,4,3,2,1,3.5,2.5,1.5,1.5,100000)'))
      .rejects.toThrow();
  });
});

describe.skipIf(!hayBaseDePruebas)('esquema 002_lead_criterios · evaluación por criterio', () => {
  it('guarda una evaluación válida de llamada', async () => {
    await expect(evaluacion()).resolves.toBeDefined();
  });

  it('un nivel de llamada distinto de NE exige cita', async () => {
    await expect(evaluacion({ cita: null })).rejects.toThrow(/lead_criterio_evaluacion_cita_ck/);
    await expect(evaluacion({ cita: '   ' })).rejects.toThrow(/lead_criterio_evaluacion_cita_ck/);
  });

  it('NE no lleva cita, pero sí se guarda como «sin información»', async () => {
    await expect(evaluacion({ nivel: 'NE', cita: null, marca_tiempo: null })).resolves.toBeDefined();
    await expect(evaluacion({ nivel: 'NE', interaccion_id: 'call-2' })).rejects.toThrow(/lead_criterio_evaluacion_ne_ck/);
  });

  it('rechaza niveles, orígenes y criterios que no existen', async () => {
    await expect(evaluacion({ nivel: 'E' })).rejects.toThrow(/lead_criterio_evaluacion_nivel_ck/);
    await expect(evaluacion({ origen: 'meet' })).rejects.toThrow(/lead_criterio_evaluacion_origen_ck/);
    await expect(evaluacion({ criterio_id: 'simpatia' })).rejects.toThrow(/lead_criterio_evaluacion_criterio_ck/);
  });

  it('el plazo en meses solo vale para Urgencia y no puede ser negativo', async () => {
    await expect(evaluacion({ criterio_id: 'urgencia', plazo_meses: 4, interaccion_id: 'c-u' })).resolves.toBeDefined();
    await expect(evaluacion({ criterio_id: 'decisor', plazo_meses: 4, interaccion_id: 'c-d' })).rejects.toThrow(/lead_criterio_evaluacion_plazo_ck/);
    await expect(evaluacion({ criterio_id: 'urgencia', plazo_meses: -1, interaccion_id: 'c-n' })).rejects.toThrow(/lead_criterio_evaluacion_plazo_ck/);
  });

  it('una evaluación de llamada exige el id de la interacción', async () => {
    await expect(evaluacion({ interaccion_id: null })).rejects.toThrow(/lead_criterio_evaluacion_llamada_ck/);
  });

  it('no se registra dos veces el mismo criterio de la misma interacción', async () => {
    await evaluacion();
    await expect(evaluacion({ nivel: 'B' })).rejects.toThrow(/lead_criterio_evaluacion_interaccion_uq/);
  });

  it('la misma interacción admite criterios distintos, y el mismo criterio otras interacciones', async () => {
    await evaluacion();
    await expect(evaluacion({ criterio_id: 'actitud', cita: 'Estamos muy ilusionados con el proyecto' })).resolves.toBeDefined();
    await expect(evaluacion({ interaccion_id: 'call-2' })).resolves.toBeDefined();
  });

  it('el nivel provisional solo es de Alcance, no puede ser NE y es único por lead', async () => {
    const prov = (extra: Record<string, unknown> = {}) =>
      evaluacion({ origen: 'formulario_provisional', criterio_id: 'alcance', nivel: 'A', cita: null, marca_tiempo: null, interaccion_id: null, ...extra });
    await expect(prov()).resolves.toBeDefined();
    await expect(prov()).rejects.toThrow(/lead_criterio_evaluacion_provisional_uq/);
    await expect(prov({ clickup_task_id: 'task-2' })).resolves.toBeDefined();
    await expect(prov({ clickup_task_id: 'task-3', criterio_id: 'decisor' })).rejects.toThrow(/lead_criterio_evaluacion_provisional_ck/);
    await expect(prov({ clickup_task_id: 'task-4', nivel: 'NE' })).rejects.toThrow(/lead_criterio_evaluacion_provisional_ck/);
  });
});

describe.skipIf(!hayBaseDePruebas)('esquema 002_lead_criterios · No apto', () => {
  it('la IA lo marca con cita', async () => {
    await expect(noApto()).resolves.toBeDefined();
  });
  it('la IA sin cita se rechaza, el comercial sin cita se acepta', async () => {
    await expect(noApto({ cita: null, interaccion_id: 'c-2' })).rejects.toThrow(/lead_no_apto_evento_cita_ck/);
    await expect(noApto({ cita: '  ', interaccion_id: 'c-3' })).rejects.toThrow(/lead_no_apto_evento_cita_ck/);
    await expect(noApto({ registrado_por: 'usuario', cita: null, valor: false, interaccion_id: null, usuario_id: 'u-1' })).resolves.toBeDefined();
  });
  it('rechaza un autor que no es ia ni usuario', async () => {
    await expect(noApto({ registrado_por: 'sistema', interaccion_id: 'c-4' })).rejects.toThrow(/lead_no_apto_evento_registrado_por_ck/);
  });
  it('una interacción no registra dos eventos de No apto', async () => {
    await noApto();
    await expect(noApto({ valor: false })).rejects.toThrow(/lead_no_apto_evento_interaccion_uq/);
  });
  it('el comercial puede dejar varios eventos manuales sin interacción', async () => {
    await noApto({ registrado_por: 'usuario', cita: null, interaccion_id: null });
    await expect(noApto({ registrado_por: 'usuario', cita: null, interaccion_id: null, valor: false })).resolves.toBeDefined();
  });
});

describe.skipIf(!hayBaseDePruebas)('esquema 001 · orden estricto del histórico', () => {
  it('dos filas del mismo instante conservan su orden por seq', async () => {
    await db.exec(`INSERT INTO lead_calificacion_historial (clickup_task_id, categoria, motivo) VALUES
      ('t-1', 'A+', 'cambio_categoria_manual'), ('t-1', 'A', 'cambio_categoria_manual')`);
    const { rows } = await db.query<{ categoria: string }>('SELECT categoria FROM lead_calificacion_historial WHERE clickup_task_id = $1 ORDER BY seq DESC', ['t-1']);
    expect(rows.map((r) => r.categoria)).toEqual(['A', 'A+']);
  });
});

describe.skipIf(!hayBaseDePruebas)('captación · reversión (schema-down.sql)', () => {
  it('quita las 7 tablas del módulo y no toca otras', async () => {
    await db.exec('CREATE TABLE crm_leads_ajena (id int)');
    await db.exec(BAJADA);
    expect(await tablas()).toEqual(['crm_leads_ajena']);
  });
  it('se puede aplicar dos veces y el esquema se puede volver a subir con su configuración', async () => {
    await db.exec(BAJADA);
    await db.exec(BAJADA);
    await ensureCaptacion(db);
    const a = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM criterio_config');
    const b = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM categoria_config');
    expect([a.rows[0]?.n, b.rows[0]?.n]).toEqual([7, 7]);
  });
  it('tras revertir, el módulo deja exactamente las 7 tablas que declara CAPTACION_TABLES (ni una más, ni una menos antes)', async () => {
    expect(await tablas()).toEqual(['agregacion_config', 'categoria_config', 'criterio_config', 'lead_calificacion_historial', 'lead_criterio_evaluacion', 'lead_no_apto_evento', 'lead_presupuesto_evento']);
    await db.exec(BAJADA);
    expect(await tablas()).toEqual([]);
  });
});
