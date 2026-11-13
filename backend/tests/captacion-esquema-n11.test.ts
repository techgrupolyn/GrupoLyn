import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureCaptacion } from '../netelip/captacion/schema.ts';
import { abrirBaseAislada, hayBaseDePruebas, type BaseAislada } from './helpers/captacion-base.ts';
import { CONFIG_V1 } from '../netelip/captacion/tipos.ts';

const BAJADA = readFileSync(new URL('../netelip/captacion/schema-down.sql', import.meta.url), 'utf8');

let db: BaseAislada;
beforeEach(async () => {
  db = await abrirBaseAislada();
  await ensureCaptacion(db);
});
afterEach(async () => {
  await db.cerrar();
});

const insertarEvento = (extra: Record<string, unknown> = {}) => {
  const v = {
    clickup_task_id: 'task-1', fuente: 'llamada_netelip', tipo: 'exacto', valor_min: 100000, valor_max: 100000,
    valor_vigente: 100000, emisor: 'cliente', interaccion_id: 'call-1', fecha_interaccion: '2026-11-10T10:00:00Z',
    registrado_por: 'ia', ...extra,
  };
  const cols = Object.keys(v);
  return db.query(
    `INSERT INTO lead_presupuesto_evento (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    Object.values(v),
  );
};

describe.skipIf(!hayBaseDePruebas)('captación · esquema N-1.1 (lead_calificacion)', () => {
  it('siembra las 7 categorías con los mismos pesos y orden que usa el motor', async () => {
    const { rows } = await db.query<{ categoria: string; valor_ponderado: string | null; orden: number }>(
      'SELECT categoria, valor_ponderado::text, orden FROM categoria_config WHERE version = 1 ORDER BY orden',
    );
    expect(rows.map((r) => [r.categoria, r.valor_ponderado === null ? null : Number(r.valor_ponderado), r.orden])).toEqual(
      CONFIG_V1.map((c) => [c.categoria, c.valorPonderado, c.orden]),
    );
  });

  it('es idempotente: aplicarlo otra vez no falla ni duplica la configuración', async () => {
    await ensureCaptacion(db);
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM categoria_config');
    expect(rows[0]?.n).toBe(7);
  });

  it('rechaza registrar dos veces la misma interacción de la misma fuente', async () => {
    await insertarEvento();
    await expect(insertarEvento()).rejects.toThrow(/lead_presupuesto_evento_interaccion_uq/);
  });

  it('permite varios eventos manuales sin interacción', async () => {
    await insertarEvento({ fuente: 'manual', interaccion_id: null, registrado_por: 'usuario' });
    await insertarEvento({ fuente: 'manual', interaccion_id: null, registrado_por: 'usuario' });
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM lead_presupuesto_evento WHERE fuente = 'manual'");
    expect(rows[0]?.n).toBe(2);
  });

  it('la misma interacción en otra fuente sí se acepta', async () => {
    await insertarEvento();
    await expect(insertarEvento({ fuente: 'reunion_meet' })).resolves.toBeDefined();
  });

  it('rechaza un presupuesto 0, una fuente desconocida y un rango al revés', async () => {
    await expect(insertarEvento({ valor_vigente: 0, interaccion_id: 'a' })).rejects.toThrow(/lead_presupuesto_evento_valor_ck/);
    await expect(insertarEvento({ fuente: 'telegram', interaccion_id: 'b' })).rejects.toThrow(/lead_presupuesto_evento_fuente_ck/);
    await expect(insertarEvento({ tipo: 'rango', valor_min: 70000, valor_max: 40000, interaccion_id: 'c' })).rejects.toThrow(/lead_presupuesto_evento_rango_ck/);
  });

  it('cada tipo de presupuesto exige los importes que le corresponden', async () => {
    const ck = /lead_presupuesto_evento_tipo_valores_ck/;
    await expect(insertarEvento({ tipo: 'rango', valor_min: 10000, valor_max: null, interaccion_id: 'r1' })).rejects.toThrow(ck);
    await expect(insertarEvento({ tipo: 'rango', valor_min: null, valor_max: 10000, interaccion_id: 'r2' })).rejects.toThrow(ck);
    await expect(insertarEvento({ tipo: 'exacto', valor_min: 10000, valor_max: 12000, interaccion_id: 'e1' })).rejects.toThrow(ck);
    await expect(insertarEvento({ tipo: 'exacto', valor_min: null, valor_max: 10000, interaccion_id: 'e2' })).rejects.toThrow(ck);
    await expect(insertarEvento({ tipo: 'abierto_superior', valor_min: null, valor_max: null, interaccion_id: 's1' })).rejects.toThrow(ck);
    await expect(insertarEvento({ tipo: 'abierto_inferior', valor_min: null, valor_max: null, interaccion_id: 'i1' })).rejects.toThrow(ck);
    // Y los válidos entran: exacto con o sin máximo, rango completo y los dos abiertos.
    await expect(insertarEvento({ tipo: 'exacto', valor_min: 10000, valor_max: null, valor_vigente: 10000, interaccion_id: 'ok1' })).resolves.toBeDefined();
    await expect(insertarEvento({ tipo: 'rango', valor_min: 40000, valor_max: 70000, valor_vigente: 55000, interaccion_id: 'ok2' })).resolves.toBeDefined();
    await expect(insertarEvento({ tipo: 'abierto_superior', valor_min: 80000, valor_max: null, valor_vigente: 80000, interaccion_id: 'ok3' })).resolves.toBeDefined();
    await expect(insertarEvento({ tipo: 'abierto_inferior', valor_min: null, valor_max: 50000, valor_vigente: 50000, interaccion_id: 'ok4' })).resolves.toBeDefined();
  });

  it('el histórico rechaza categorías y motivos que no existen, y puntuación o cobertura fuera de rango', async () => {
    const fila = (c: Record<string, unknown>) =>
      db.query(
        'INSERT INTO lead_calificacion_historial (clickup_task_id, categoria, motivo, puntuacion, cobertura) VALUES ($1,$2,$3,$4,$5)',
        ['task-1', c.categoria ?? 'A', c.motivo ?? 'alta', c.puntuacion ?? null, c.cobertura ?? null],
      );
    await expect(fila({})).resolves.toBeDefined();
    await expect(fila({ categoria: 'E' })).rejects.toThrow(/categoria_ck/);
    await expect(fila({ motivo: 'otro' })).rejects.toThrow(/motivo_ck/);
    await expect(fila({ puntuacion: 4.5 })).rejects.toThrow();
    await expect(fila({ cobertura: 120 })).rejects.toThrow(/cobertura_ck/);
  });

  it('si se borra un evento, el histórico lo conserva con el enlace en NULL', async () => {
    const { rows } = await insertarEvento();
    const id = (rows[0] as { id: string }).id;
    await db.query(
      "INSERT INTO lead_calificacion_historial (clickup_task_id, categoria, motivo, evento_presupuesto_id) VALUES ('task-1','A+','alta',$1)",
      [id],
    );
    await db.query('DELETE FROM lead_presupuesto_evento WHERE id = $1', [id]);
    const r = await db.query<{ evento_presupuesto_id: string | null }>('SELECT evento_presupuesto_id FROM lead_calificacion_historial');
    expect(r.rows[0]?.evento_presupuesto_id).toBeNull();
  });

  it('la reversión quita solo las tablas de la captación y no toca otras', async () => {
    await db.exec('CREATE TABLE crm_leads_ajena (id int)');
    await db.exec(BAJADA);
    const { rows } = await db.query<{ tabla: string }>(
      "SELECT table_name AS tabla FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1",
    );
    expect(rows.map((r) => r.tabla)).toEqual(['crm_leads_ajena']);
  });

  it('la reversión se puede aplicar dos veces y el esquema se puede volver a subir', async () => {
    await db.exec(BAJADA);
    await db.exec(BAJADA);
    await ensureCaptacion(db);
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM categoria_config');
    expect(rows[0]?.n).toBe(7);
  });
});
