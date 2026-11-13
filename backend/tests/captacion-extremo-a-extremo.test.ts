import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureCaptacion } from '../netelip/captacion/schema.ts';
import { abrirBaseAislada, hayBaseDePruebas, type BaseAislada } from './helpers/captacion-base.ts';
import { nivelAlcanceProvisional } from '../netelip/captacion/agregacion.ts';
import { CRITERIOS_IDS, type CriterioId, type Nivel } from '../netelip/captacion/matriz.ts';
import {
  cargarConfig,
  procesarEvaluacionLlamada,
  recalcularLead,
  recalcularTodos,
  registrarAlcanceProvisional,
  registrarNoAptoManual,
  type Db,
  type ResultadoProcesar,
} from '../netelip/captacion/repositorio.ts';

// Recorrido de punta a punta de N-1.1 + N-1.2 contra un Postgres real (con el driver pg del repo y un esquema aislado por prueba):
// salida del modelo → validación → citas → base de datos → categoría, ponderado, histórico y lo que
// se escribiría en ClickUp. No hay red: el «modelo» es el JSON que cada prueba construye.

let base: BaseAislada;
let db: Db;
beforeEach(async () => {
  base = await abrirBaseAislada();
  await ensureCaptacion(base);
  db = base as unknown as Db;
});
afterEach(async () => {
  await base.cerrar();
});

const D = (dia: number): string => `2026-11-${String(dia).padStart(2, '0')}T10:00:00.000Z`;
const filas = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await db.query(sql, params)).rows as T[];
const contar = async (tabla: string): Promise<number> => Number((await filas<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabla}`))[0]?.n);

type Crit = { nivel?: Nivel; plazo?: number; cita: string; inventada?: boolean };
interface Guion {
  criterios?: Partial<Record<CriterioId, Crit>>;
  presupuesto?: { tipo: string; min: number | null; max: number | null; emisor: 'cliente' | 'lyn'; cita: string; inventada?: boolean };
  noApto?: { valor: boolean; cita: string | null; inventada?: boolean };
}

/** Arma la transcripción (con las frases que de verdad «se dijeron») y la salida del modelo de una llamada. */
function llamada(interaccionId: string, g: Guion): { transcripcion: string; salidaModelo: string } {
  const lineas = ['[00:00:02] GRUPO LYN: Hola [NOMBRE], te llamo de Grupo LYN por tu solicitud de reforma.'];
  const decir = (cita: string | null, inventada: boolean | undefined, quien = 'CLIENTE') => {
    if (cita && !inventada) lineas.push(`[00:01:00] ${quien}: ${cita}.`);
  };
  const criterios: Record<string, unknown> = {};
  for (const id of CRITERIOS_IDS) {
    const c = g.criterios?.[id];
    if (!c) {
      criterios[id] = id === 'urgencia' ? { plazo_meses: null, cita: null, marca_tiempo: null } : { nivel: 'NE', cita: null, marca_tiempo: null };
      continue;
    }
    decir(c.cita, c.inventada);
    criterios[id] = id === 'urgencia'
      ? { plazo_meses: c.plazo, cita: c.cita, marca_tiempo: '00:01:00' }
      : { nivel: c.nivel, cita: c.cita, marca_tiempo: '00:01:00' };
  }
  if (g.presupuesto) decir(g.presupuesto.cita, g.presupuesto.inventada, g.presupuesto.emisor === 'lyn' ? 'GRUPO LYN' : 'CLIENTE');
  if (g.noApto) decir(g.noApto.cita, g.noApto.inventada);
  const salida = {
    interaccion_id: interaccionId,
    presupuesto: g.presupuesto
      ? { detectado: true, tipo: g.presupuesto.tipo, min: g.presupuesto.min, max: g.presupuesto.max, moneda: 'EUR', emisor: g.presupuesto.emisor, cita: g.presupuesto.cita, marca_tiempo: '00:01:00' }
      : { detectado: false },
    presupuesto_insuficiente_sin_solucion: g.noApto
      ? { valor: g.noApto.valor, cita: g.noApto.cita, marca_tiempo: g.noApto.cita ? '00:01:00' : null }
      : { valor: false, cita: null, marca_tiempo: null },
    criterios,
    resumen: { que_quiere: '', donde_quedo: '', que_lo_frena: '', para_que_llamarlo: '', fecha_prevista: null },
  };
  return { transcripcion: lineas.join('\n'), salidaModelo: JSON.stringify(salida) };
}

const procesar = async (lead: string, id: string, dia: number, g: Guion, conexion: Db = db): Promise<ResultadoProcesar> =>
  procesarEvaluacionLlamada(conexion, { clickupTaskId: lead, interaccionId: id, fechaInteraccion: D(dia), ...llamada(id, g) });
const ok = (r: ResultadoProcesar) => {
  if (r.estado !== 'procesada') throw new Error(`se esperaba procesada y fue ${r.estado}`);
  return r;
};

const CITA = {
  presupuesto: 'Con ese importe vamos muy holgados para todo',
  urgencia: 'Queremos empezar la obra en unos cuatro meses',
  decisor: 'Decidimos mi pareja y yo y estamos de acuerdo',
  alcance: 'Queremos reformar la vivienda entera salvo algún detalle',
  actitud: 'Estamos muy ilusionados y con ganas de empezar',
  encaje: 'Estamos comparando bastante el precio con otras empresas',
  f2f3: 'Nos viene bien ir a la oficina el jueves',
  rango: 'Tenemos pensado entre cuarenta y setenta mil euros',
  insuficiente: 'No llegamos a más de veinte mil y no hay forma',
  solucionado: 'Al final nos han concedido el préstamo que faltaba',
};
/** La llamada del primer escenario del ticket: Pres A, Urg 4 meses, Dec A, Alc B, Act A, Enc C, F2/F3 sin información. */
const ESCENARIO_1: Guion = {
  criterios: {
    presupuesto: { nivel: 'A', cita: CITA.presupuesto },
    urgencia: { plazo: 4, cita: CITA.urgencia },
    decisor: { nivel: 'A', cita: CITA.decisor },
    alcance: { nivel: 'B', cita: CITA.alcance },
    actitud: { nivel: 'A', cita: CITA.actitud },
    encaje_lyn: { nivel: 'C', cita: CITA.encaje },
  },
  presupuesto: { tipo: 'rango', min: 40000, max: 70000, emisor: 'cliente', cita: CITA.rango },
};
/** Todo en A (urgencia 2 meses) con un presupuesto exacto. */
const todoA = (importe: number, nivelPresupuesto: Nivel = 'A'): Guion => ({
  criterios: {
    presupuesto: { nivel: nivelPresupuesto, cita: CITA.presupuesto },
    urgencia: { plazo: 2, cita: 'Nos gustaría empezar dentro de dos meses' },
    decisor: { nivel: 'A', cita: CITA.decisor },
    alcance: { nivel: 'A', cita: 'Es una reforma integral de toda la casa' },
    actitud: { nivel: 'A', cita: CITA.actitud },
    encaje_lyn: { nivel: 'A', cita: 'Nos encanta vuestro método y el diseño' },
    predisposicion_f2f3: { nivel: 'A', cita: CITA.f2f3 },
  },
  presupuesto: { tipo: 'exacto', min: importe, max: importe, emisor: 'cliente', cita: 'Ese es el dinero que tenemos para la obra' },
});

describe.skipIf(!hayBaseDePruebas)('una llamada de punta a punta', () => {
  it('Escenario: categoría global calculada por la matriz, con presupuesto, ponderado, desglose e histórico', async () => {
    const r = ok(await procesar('lead-1', 'call-1', 10, ESCENARIO_1));
    expect(r.recalculo.agregacion).toMatchObject({ puntuacion: 3.42, cobertura: 95, categoria: 'B' });
    expect(r.recalculo.agregacion.niveles).toMatchObject({ urgencia: 'B', predisposicion_f2f3: 'NE' });
    expect(r.recalculo.escrituras).toEqual({
      categoria: 'B',
      presupuesto: 55000,
      ponderado: 41250,
      fuente_presupuesto: 'Llamada',
      desglose: 'Pres A · Urg B · Dec A · Alc B · Act A · Enc C · F2/F3 NE · 3,42 · cob. 95 %',
    });

    const criterios = await filas<{ criterio_id: string; nivel: string; plazo: number | null; cita: string | null }>(
      "SELECT criterio_id, nivel, plazo_meses::float8 AS plazo, cita FROM lead_criterio_evaluacion WHERE interaccion_id = 'call-1' ORDER BY criterio_id",
    );
    expect(criterios).toHaveLength(7);
    expect(criterios.find((c) => c.criterio_id === 'urgencia')).toMatchObject({ nivel: 'B', plazo: 4, cita: CITA.urgencia });
    expect(criterios.find((c) => c.criterio_id === 'predisposicion_f2f3')).toMatchObject({ nivel: 'NE', cita: null });

    const historial = await filas('SELECT categoria, motivo, puntuacion::float8 AS puntuacion, cobertura::float8 AS cobertura, presupuesto_vigente::float8 AS presupuesto, valor_ponderado::float8 AS factor, ponderado::float8 AS ponderado, version_config FROM lead_calificacion_historial');
    expect(historial).toEqual([
      { categoria: 'B', motivo: 'evaluacion_ia', puntuacion: 3.42, cobertura: 95, presupuesto: 55000, factor: 0.75, ponderado: 41250, version_config: 1 },
    ]);
  });

  it('Escenario: rango que dice el cliente (tipo rango, min, max, emisor, cita y fecha de la llamada)', async () => {
    ok(await procesar('lead-1', 'call-1', 10, ESCENARIO_1));
    const [e] = await filas('SELECT fuente, tipo, valor_min::float8 AS min, valor_max::float8 AS max, valor_vigente::float8 AS vigente, emisor, cita_textual, interaccion_id, fecha_interaccion, registrado_por FROM lead_presupuesto_evento');
    expect(e).toMatchObject({
      fuente: 'llamada_netelip', tipo: 'rango', min: 40000, max: 70000, vigente: 55000, emisor: 'cliente',
      cita_textual: CITA.rango, interaccion_id: 'call-1', registrado_por: 'ia',
    });
    expect(new Date(String(e?.fecha_interaccion)).toISOString()).toBe(D(10));
  });

  it('Escenario: rango que da LYN (emisor lyn): se guarda con su emisor y CUENTA como presupuesto del lead (cuentan los dos canales)', async () => {
    const r = ok(await procesar('lead-2', 'call-2', 10, {
      presupuesto: { tipo: 'rango', min: 60000, max: 80000, emisor: 'lyn', cita: 'Su proyecto estaría entre sesenta y ochenta mil euros' },
    }));
    expect(r.registro.presupuesto).toBe(true);
    const [e] = await filas('SELECT emisor, valor_vigente::float8 AS vigente FROM lead_presupuesto_evento');
    expect(e).toEqual({ emisor: 'lyn', vigente: 70000 });
    expect(r.recalculo.escrituras).toMatchObject({ presupuesto: 70000, fuente_presupuesto: 'Llamada' });
  });

  it('Escenario: una horquilla posterior de LYN para toda la reforma sustituye al presupuesto anterior y puede dar A+', async () => {
    // Todo en A con un presupuesto del cliente de 60.000 €: es A (el A+ pide 100.000 €).
    const primera = ok(await procesar('lead-3', 'call-1', 5, todoA(60_000)));
    expect(primera.recalculo.escrituras).toMatchObject({ categoria: 'A', presupuesto: 60000 });
    // Una llamada posterior en la que LYN da una horquilla de 177.000 a 186.000 €: manda la más reciente y hay A+.
    const r = ok(await procesar('lead-3', 'call-2', 9, {
      ...todoA(60_000),
      presupuesto: { tipo: 'rango', min: 177000, max: 186000, emisor: 'lyn', cita: 'Para lo que me cuentas estaría entre ciento setenta y siete y ciento ochenta y seis mil' },
    }));
    expect(await contar('lead_presupuesto_evento')).toBe(2);
    expect(r.recalculo.agregacion.aPlusPermitido).toBe(true);
    expect(r.recalculo.escrituras).toMatchObject({ categoria: 'A+', presupuesto: 181500, ponderado: 181500 });
  });

  it('Escenario: una cifra pequeña de LYN (una ampliación, un extra) se guarda pero NO sustituye al presupuesto del proyecto', async () => {
    const primera = ok(await procesar('lead-4', 'call-1', 5, todoA(60_000)));
    expect(primera.recalculo.escrituras).toMatchObject({ categoria: 'A', presupuesto: 60000 });
    const r = ok(await procesar('lead-4', 'call-2', 9, {
      ...todoA(60_000),
      presupuesto: { tipo: 'exacto', min: 8000, max: 8000, emisor: 'lyn', cita: 'La ampliación del salón saldría por unos ocho mil euros' },
    }));
    expect(await contar('lead_presupuesto_evento')).toBe(2);
    expect(r.recalculo.escrituras).toMatchObject({ categoria: 'A', presupuesto: 60000, ponderado: 60000 });
  });

  it('solo escribe en ClickUp los campos permitidos', async () => {
    const r = ok(await procesar('lead-1', 'call-1', 10, ESCENARIO_1));
    expect(Object.keys(r.recalculo.escrituras).sort()).toEqual(['categoria', 'desglose', 'fuente_presupuesto', 'ponderado', 'presupuesto']);
  });

  it('Escenario: reproceso idempotente (ni evaluaciones, ni presupuesto, ni histórico duplicados)', async () => {
    ok(await procesar('lead-1', 'call-1', 10, ESCENARIO_1));
    const otra = ok(await procesar('lead-1', 'call-1', 10, ESCENARIO_1));
    expect(otra.registro).toMatchObject({ criterios: 0, presupuesto: false, noApto: false });
    expect(otra.recalculo.filasInsertadas).toBe(0);
    expect(otra.recalculo.escrituras.categoria).toBe('B');
    expect([await contar('lead_criterio_evaluacion'), await contar('lead_presupuesto_evento'), await contar('lead_calificacion_historial')]).toEqual([7, 1, 1]);
  });
});

describe.skipIf(!hayBaseDePruebas)('varias llamadas del mismo lead', () => {
  it('Escenario: una llamada sin información no borra lo evaluado', async () => {
    ok(await procesar('lead-1', 'call-1', 5, ESCENARIO_1));
    const r = ok(await procesar('lead-1', 'call-2', 9, { criterios: { decisor: { nivel: 'C', cita: 'Mi mujer no lo tiene nada claro todavía' } } }));
    expect(r.recalculo.agregacion.niveles).toMatchObject({ urgencia: 'B', decisor: 'C', presupuesto: 'A' });
    expect(await contar('lead_criterio_evaluacion')).toBe(14);
  });

  it('una llamada antigua procesada tarde queda guardada pero no pisa ni los niveles ni el presupuesto', async () => {
    ok(await procesar('lead-1', 'nueva', 10, { criterios: { decisor: { nivel: 'A', cita: CITA.decisor } }, presupuesto: { tipo: 'exacto', min: 120000, max: 120000, emisor: 'cliente', cita: 'Contamos con ciento veinte mil euros' } }));
    const r = ok(await procesar('lead-1', 'vieja', 1, { criterios: { decisor: { nivel: 'D', cita: 'Eso lo decide mi padre, no yo' } }, presupuesto: { tipo: 'exacto', min: 30000, max: 30000, emisor: 'cliente', cita: 'Solo tenemos treinta mil euros ahorrados' } }));
    expect(r.recalculo.agregacion.niveles.decisor).toBe('A');
    expect(r.recalculo.escrituras.presupuesto).toBe(120000);
    expect(await contar('lead_presupuesto_evento')).toBe(2);
  });

  it('Escenario: Alcance provisional desde el formulario, y la primera llamada con evidencia lo sustituye', async () => {
    const nivel = nivelAlcanceProvisional({ tipoContacto: 'Reforma integral de vivienda' });
    expect(await registrarAlcanceProvisional(db, { clickupTaskId: 'lead-1', nivel, fechaInteraccion: D(1) })).toBe(true);
    expect(await registrarAlcanceProvisional(db, { clickupTaskId: 'lead-1', nivel: 'D', fechaInteraccion: D(2) })).toBe(false);
    const alta = await recalcularLead(db, 'lead-1', { disparador: 'alta' });
    expect(alta.agregacion.niveles.alcance).toBe('A');
    expect(alta.calificacion.categoria).toBe('sin_calificar');
    expect(alta.escrituras.desglose).toBe('Pres NE · Urg NE · Dec NE · Alc A · Act NE · Enc NE · F2/F3 NE · 4,00 · cob. 10 %');
    expect(await filas("SELECT nivel, origen FROM lead_criterio_evaluacion")).toEqual([{ nivel: 'A', origen: 'formulario_provisional' }]);

    const r = ok(await procesar('lead-1', 'call-1', 10, { criterios: { alcance: { nivel: 'C', cita: 'Bueno, la cocina y un baño los dejaríamos como están' } } }));
    expect(r.recalculo.agregacion.niveles.alcance).toBe('C');
  });
});

describe.skipIf(!hayBaseDePruebas)('No apto', () => {
  it('Escenario: presupuesto insuficiente sin solución → No apto con ponderado 0, y se levanta con una cita posterior', async () => {
    const antes = ok(await procesar('lead-1', 'call-1', 5, todoA(150000)));
    expect(antes.recalculo.escrituras).toMatchObject({ categoria: 'A+', ponderado: 150000 });

    const marcado = ok(await procesar('lead-1', 'call-2', 8, { noApto: { valor: true, cita: CITA.insuficiente } }));
    expect(marcado.registro.noApto).toBe(true);
    expect(marcado.recalculo.escrituras).toMatchObject({ categoria: 'no_apto', ponderado: 0, presupuesto: 150000 });

    const levantado = ok(await procesar('lead-1', 'call-3', 10, { noApto: { valor: false, cita: CITA.solucionado } }));
    expect(levantado.recalculo.escrituras).toMatchObject({ categoria: 'A+', ponderado: 150000 });
    expect((await filas<{ categoria: string }>('SELECT categoria FROM lead_calificacion_historial ORDER BY seq')).map((f) => f.categoria)).toEqual(['A+', 'no_apto', 'A+']);
  });

  it('Escenario: No apto sin cita verificable no se aplica y queda en revisión manual', async () => {
    ok(await procesar('lead-1', 'call-1', 5, todoA(150000)));
    const r = ok(await procesar('lead-1', 'call-2', 8, { noApto: { valor: true, cita: CITA.insuficiente, inventada: true } }));
    expect(r.recalculo.escrituras.categoria).toBe('A+');
    expect(r.registro.noApto).toBe(false);
    expect(r.registro.revisionManual).toEqual(['presupuesto insuficiente sin solución señalado sin una cita verificable']);
    expect(await contar('lead_no_apto_evento')).toBe(0);
  });

  it('el comercial lo quita a mano y la siguiente llamada ya no lo vuelve a marcar', async () => {
    ok(await procesar('lead-1', 'call-1', 5, todoA(150000)));
    ok(await procesar('lead-1', 'call-2', 6, { noApto: { valor: true, cita: CITA.insuficiente } }));
    await registrarNoAptoManual(db, { clickupTaskId: 'lead-1', valor: false, usuarioId: 'u-ernesto', fecha: D(7) });
    const manual = await recalcularLead(db, 'lead-1', { disparador: 'categoria_manual', categoriaElegida: 'B' });
    expect(manual.escrituras).toMatchObject({ categoria: 'B', ponderado: 112500 });
    const siguiente = ok(await procesar('lead-1', 'call-3', 9, { criterios: { actitud: { nivel: 'A', cita: CITA.actitud } } }));
    expect(siguiente.recalculo.escrituras.categoria).toBe('A+');
  });
});

describe.skipIf(!hayBaseDePruebas)('A+ por matriz', () => {
  it('Escenario: categoría A, criterio Presupuesto en A y 100.000 € exactos → A+', async () => {
    const r = ok(await procesar('lead-1', 'call-1', 5, todoA(100000)));
    expect(r.recalculo.escrituras).toMatchObject({ categoria: 'A+', ponderado: 100000 });
  });
  it('99.999 € se queda en A', async () => {
    expect(ok(await procesar('lead-1', 'call-1', 5, todoA(99999))).recalculo.escrituras.categoria).toBe('A');
  });
  it('Escenario: A con presupuesto alto pero justo (criterio Presupuesto en C, 150.000 €) sigue siendo A', async () => {
    const r = ok(await procesar('lead-1', 'call-1', 5, todoA(150000, 'C')));
    expect(r.recalculo.agregacion).toMatchObject({ puntuacion: 3.5, aPlusPermitido: false });
    expect(r.recalculo.escrituras).toMatchObject({ categoria: 'A', ponderado: 150000 });
  });
  it('si la categoría la puso la matriz, un presupuesto nuevo la sube a A+ solo si el criterio lo permite', async () => {
    ok(await procesar('lead-ok', 'c-ok', 5, todoA(90000)));
    ok(await procesar('lead-justo', 'c-justo', 5, todoA(90000, 'C')));
    for (const lead of ['lead-ok', 'lead-justo']) {
      await db.query(
        `INSERT INTO lead_presupuesto_evento (clickup_task_id, fuente, tipo, valor_min, valor_max, valor_vigente, emisor, fecha_interaccion, registrado_por, usuario_id)
         VALUES ($1, 'manual', 'exacto', 130000, 130000, 130000, 'cliente', $2, 'usuario', 'u-1')`,
        [lead, D(8)],
      );
    }
    const sube = await recalcularLead(db, 'lead-ok', { disparador: 'presupuesto' });
    expect(sube.escrituras).toMatchObject({ categoria: 'A+', presupuesto: 130000, fuente_presupuesto: 'Manual' });
    expect(sube.calificacion.historial.map((f) => f.motivo)).toEqual(['cambio_presupuesto']);
    const noSube = await recalcularLead(db, 'lead-justo', { disparador: 'presupuesto' });
    expect(noSube.escrituras).toMatchObject({ categoria: 'A', presupuesto: 130000 });
  });
});

describe.skipIf(!hayBaseDePruebas)('lo que el código descarta', () => {
  it('Escenario: nivel sin cita verificable se guarda como NE para esa llamada y queda el descarte', async () => {
    const r = ok(await procesar('lead-1', 'call-1', 5, { criterios: { actitud: { nivel: 'A', cita: 'Se nota que tiene muchísimas ganas', inventada: true }, decisor: { nivel: 'A', cita: CITA.decisor } } }));
    expect(r.descartes).toEqual([{ campo: 'criterios.actitud', motivo: 'cita no encontrada en la transcripción', cita: 'Se nota que tiene muchísimas ganas' }]);
    expect(await filas("SELECT nivel, cita FROM lead_criterio_evaluacion WHERE criterio_id = 'actitud'")).toEqual([{ nivel: 'NE', cita: null }]);
    expect(r.recalculo.agregacion.niveles).toMatchObject({ actitud: 'NE', decisor: 'A' });
  });

  it('un rango abierto no se registra solo: va a revisión manual y el resto de la llamada sí se guarda', async () => {
    const r = ok(await procesar('lead-1', 'call-1', 5, { criterios: { decisor: { nivel: 'A', cita: CITA.decisor } }, presupuesto: { tipo: 'abierto_superior', min: 80000, max: null, emisor: 'cliente', cita: 'Podemos gastar más de ochenta mil euros' } }));
    expect(r.registro.presupuesto).toBe(false);
    expect(r.registro.revisionManual).toHaveLength(1);
    expect(r.registro.revisionManual[0]).toMatch(/abierto_superior/);
    expect([await contar('lead_presupuesto_evento'), await contar('lead_criterio_evaluacion')]).toEqual([0, 7]);
  });

  it('un importe fuera de 1.000 a 5.000.000 € no se registra y va a revisión manual', async () => {
    const r = ok(await procesar('lead-1', 'call-1', 5, { presupuesto: { tipo: 'exacto', min: 9_000_000, max: 9_000_000, emisor: 'cliente', cita: 'Tenemos nueve millones para la reforma entera' } }));
    expect(r.registro.presupuesto).toBe(false);
    expect(r.registro.revisionManual).toHaveLength(1);
    expect(await contar('lead_presupuesto_evento')).toBe(0);
  });
});

describe.skipIf(!hayBaseDePruebas)('fallos: la calificación del lead no cambia', () => {
  const tablas = ['lead_criterio_evaluacion', 'lead_presupuesto_evento', 'lead_no_apto_evento', 'lead_calificacion_historial'];
  // Una consulta tras otra: la prueba usa una sola conexión.
  const totales = async () => {
    const resultado: number[] = [];
    for (const t of tablas) resultado.push(await contar(t));
    return resultado;
  };

  it('Escenario: respuesta inválida del modelo → no se guarda nada', async () => {
    ok(await procesar('lead-1', 'call-1', 5, ESCENARIO_1));
    const antes = await totales();
    const base = { clickupTaskId: 'lead-1', interaccionId: 'call-2', fechaInteraccion: D(9), transcripcion: 'x' };
    expect(await procesarEvaluacionLlamada(db, { ...base, salidaModelo: 'esto no es JSON' })).toEqual({ estado: 'salida_invalida', error: 'la respuesta no es JSON' });
    expect((await procesarEvaluacionLlamada(db, { ...base, salidaModelo: llamada('otra-llamada', ESCENARIO_1).salidaModelo })).estado).toBe('salida_invalida');
    expect((await procesarEvaluacionLlamada(db, { ...base, salidaModelo: '{"interaccion_id":"call-2"}' })).estado).toBe('salida_invalida');
    expect(await totales()).toEqual(antes);
  });

  it('si algo falla al guardar, la transacción se deshace entera', async () => {
    ok(await procesar('lead-1', 'call-1', 5, ESCENARIO_1));
    const antes = await totales();
    const roto: Db = {
      query: (sql, params) =>
        sql.includes('INSERT INTO lead_calificacion_historial') ? Promise.reject(new Error('fallo simulado')) : db.query(sql, params),
    };
    await expect(procesar('lead-1', 'call-2', 9, todoA(200000), roto)).rejects.toThrow('fallo simulado');
    expect(await totales()).toEqual(antes);
    // Y la base sigue utilizable: la misma llamada se procesa bien después.
    expect(ok(await procesar('lead-1', 'call-2', 9, todoA(200000))).recalculo.escrituras.categoria).toBe('A+');
  });
});

describe.skipIf(!hayBaseDePruebas)('integración con N-1.1: categoría manual del comercial (P-12)', () => {
  const presupuestoManual = (lead: string, importe: number, dia: number) =>
    db.query(
      `INSERT INTO lead_presupuesto_evento (clickup_task_id, fuente, tipo, valor_min, valor_max, valor_vigente, emisor, fecha_interaccion, registrado_por, usuario_id)
       VALUES ($1, 'manual', 'exacto', $2, $2, $2, 'cliente', $3, 'usuario', 'u-1')`,
      [lead, importe, D(dia)],
    );

  it('el cambio manual se mantiene hasta que se procesa la siguiente llamada, que lo sustituye', async () => {
    await presupuestoManual('lead-1', 80000, 1);
    const alta = await recalcularLead(db, 'lead-1', { disparador: 'alta', categoriaElegida: 'C' });
    expect(alta.escrituras).toEqual({ categoria: 'C', presupuesto: 80000, ponderado: 36000, fuente_presupuesto: 'Manual' });

    const porLlamada = ok(await procesar('lead-1', 'call-1', 3, { ...ESCENARIO_1, presupuesto: undefined }));
    expect(porLlamada.recalculo.escrituras).toMatchObject({ categoria: 'B', ponderado: 60000 });

    const manual = await recalcularLead(db, 'lead-1', { disparador: 'categoria_manual', categoriaElegida: 'A' });
    expect(manual.escrituras).toMatchObject({ categoria: 'A', ponderado: 80000 });

    // Un cambio de presupuesto no es una llamada: la categoría manual se conserva (y aplica la regla de A+ de N-1.1).
    await presupuestoManual('lead-1', 200000, 5);
    const conMasPresupuesto = await recalcularLead(db, 'lead-1', { disparador: 'presupuesto' });
    expect(conMasPresupuesto.escrituras).toMatchObject({ categoria: 'A+', ponderado: 200000 });

    const siguiente = ok(await procesar('lead-1', 'call-2', 7, { criterios: { decisor: { nivel: 'C', cita: 'Mi mujer no lo tiene nada claro todavía' } } }));
    expect(siguiente.recalculo.agregacion.puntuacion).toBe(3.11);
    expect(siguiente.recalculo.escrituras).toMatchObject({ categoria: 'B', ponderado: 150000 });
    expect((await filas<{ motivo: string; categoria: string }>('SELECT motivo, categoria FROM lead_calificacion_historial ORDER BY seq')).map((f) => `${f.motivo}:${f.categoria}`)).toEqual([
      'alta:C', 'evaluacion_ia:B', 'cambio_categoria_manual:A', 'cambio_presupuesto:A+', 'evaluacion_ia:B',
    ]);
  });
});

describe.skipIf(!hayBaseDePruebas)('Escenario: cambio de configuración', () => {
  const publicarPesos = async (version: number, pesos: Record<CriterioId, number>) => {
    for (const id of CRITERIOS_IDS) {
      await db.query(
        `INSERT INTO criterio_config (criterio_id, version, nombre, etiqueta, peso, descriptor_a, descriptor_b, descriptor_c, descriptor_d, orden)
         SELECT criterio_id, $2, nombre, etiqueta, $3, descriptor_a, descriptor_b, descriptor_c, descriptor_d, orden
         FROM criterio_config WHERE criterio_id = $1 AND version = 1`,
        [id, version, pesos[id]],
      );
    }
  };

  it('todos los leads se recalculan con la versión nueva y el histórico deja el motivo y la versión', async () => {
    ok(await procesar('lead-matriz', 'call-1', 5, ESCENARIO_1));
    await db.query(
      `INSERT INTO lead_presupuesto_evento (clickup_task_id, fuente, tipo, valor_min, valor_max, valor_vigente, emisor, fecha_interaccion, registrado_por)
       VALUES ('lead-manual', 'manual', 'exacto', 200000, 200000, 200000, 'cliente', $1, 'usuario')`,
      [D(2)],
    );
    await recalcularLead(db, 'lead-manual', { disparador: 'alta', categoriaElegida: 'B' });
    // Un lead al que el cambio no le afecta (A manual con 50.000 €): también debe constar su recálculo.
    await db.query(
      `INSERT INTO lead_presupuesto_evento (clickup_task_id, fuente, tipo, valor_min, valor_max, valor_vigente, emisor, fecha_interaccion, registrado_por)
       VALUES ('lead-igual', 'manual', 'exacto', 50000, 50000, 50000, 'cliente', $1, 'usuario')`,
      [D(2)],
    );
    await recalcularLead(db, 'lead-igual', { disparador: 'alta', categoriaElegida: 'A' });
    expect((await cargarConfig(db)).version).toBe(1);
    // Con la misma versión no hay nada que recalcular.
    expect(await recalcularTodos(db)).toMatchObject({ leads: 3, filasInsertadas: 0 });

    // Versión 2: Presupuesto pesa 40 y Urgencia 10; y la categoría B pondera 0,80.
    await publicarPesos(2, { presupuesto: 40, urgencia: 10, decisor: 15, alcance: 10, actitud: 10, encaje_lyn: 10, predisposicion_f2f3: 5 });
    await db.query(
      `INSERT INTO categoria_config (categoria, version, valor_ponderado, orden)
       SELECT categoria, 2, CASE WHEN categoria = 'B' THEN 0.80 ELSE valor_ponderado END, orden FROM categoria_config WHERE version = 1`,
    );
    expect((await cargarConfig(db)).version).toBe(2);

    const r = await recalcularTodos(db);
    expect(r).toMatchObject({ leads: 3, filasInsertadas: 3 });
    const porLead = Object.fromEntries(r.cambios.map((c) => [c.clickupTaskId, c.escrituras]));
    // (40·4 + 10·3 + 15·4 + 10·3 + 10·4 + 10·2) ÷ 95 = 3,58 → A.
    expect(porLead['lead-matriz']).toMatchObject({ categoria: 'A', ponderado: 55000, desglose: 'Pres A · Urg B · Dec A · Alc B · Act A · Enc C · F2/F3 NE · 3,58 · cob. 95 %' });
    // La categoría manual se conserva; cambia su ponderado: 200.000 × 0,80.
    expect(porLead['lead-manual']).toMatchObject({ categoria: 'B', ponderado: 160000 });
    expect(porLead['lead-igual']).toMatchObject({ categoria: 'A', ponderado: 50000 });
    expect(await filas("SELECT clickup_task_id, categoria, version_config FROM lead_calificacion_historial WHERE motivo = 'recalculo_config' ORDER BY 1")).toEqual([
      { clickup_task_id: 'lead-igual', categoria: 'A', version_config: 2 },
      { clickup_task_id: 'lead-manual', categoria: 'B', version_config: 2 },
      { clickup_task_id: 'lead-matriz', categoria: 'A', version_config: 2 },
    ]);

    // Repetir el recálculo con la misma versión no agrega nada.
    expect(await recalcularTodos(db)).toMatchObject({ leads: 3, filasInsertadas: 0, cambios: [] });
  });

  it('si alguien edita un peso en su sitio (sin versión nueva), el recálculo también lo detecta', async () => {
    await db.query(
      `INSERT INTO lead_presupuesto_evento (clickup_task_id, fuente, tipo, valor_min, valor_max, valor_vigente, emisor, fecha_interaccion, registrado_por)
       VALUES ('lead-manual', 'manual', 'exacto', 200000, 200000, 200000, 'cliente', $1, 'usuario')`,
      [D(2)],
    );
    await recalcularLead(db, 'lead-manual', { disparador: 'alta', categoriaElegida: 'B' });
    await db.query("UPDATE categoria_config SET valor_ponderado = 0.80 WHERE categoria = 'B' AND version = 1");
    const r = await recalcularTodos(db);
    expect(r.filasInsertadas).toBe(1);
    expect(r.cambios[0]?.escrituras).toMatchObject({ categoria: 'B', ponderado: 160000 });
  });

  it('el recálculo general es todo o nada: si falla a mitad no deja leads a medias y el reintento devuelve todos los cambios', async () => {
    for (const lead of ['lead-a', 'lead-b']) {
      await db.query(
        `INSERT INTO lead_presupuesto_evento (clickup_task_id, fuente, tipo, valor_min, valor_max, valor_vigente, emisor, fecha_interaccion, registrado_por)
         VALUES ($1, 'manual', 'exacto', 200000, 200000, 200000, 'cliente', $2, 'usuario')`,
        [lead, D(2)],
      );
      await recalcularLead(db, lead, { disparador: 'alta', categoriaElegida: 'B' });
    }
    await db.query(
      `INSERT INTO categoria_config (categoria, version, valor_ponderado, orden)
       SELECT categoria, 2, CASE WHEN categoria = 'B' THEN 0.80 ELSE valor_ponderado END, orden FROM categoria_config WHERE version = 1`,
    );
    let inserciones = 0;
    const roto: Db = {
      query: (sql, params) =>
        sql.includes('INSERT INTO lead_calificacion_historial') && ++inserciones === 2
          ? Promise.reject(new Error('fallo simulado'))
          : db.query(sql, params),
    };
    await expect(recalcularTodos(roto)).rejects.toThrow('fallo simulado');
    expect(await filas("SELECT 1 FROM lead_calificacion_historial WHERE motivo = 'recalculo_config'")).toEqual([]);

    const r = await recalcularTodos(db);
    expect(r.cambios.map((c) => [c.clickupTaskId, c.escrituras.ponderado])).toEqual([['lead-a', 160000], ['lead-b', 160000]]);
  });

  it('una versión publicada a medias no se usa: el recálculo se niega', async () => {
    await db.query(
      `INSERT INTO criterio_config (criterio_id, version, nombre, etiqueta, peso, descriptor_a, descriptor_b, descriptor_c, descriptor_d, orden)
       SELECT criterio_id, 2, nombre, etiqueta, peso, descriptor_a, descriptor_b, descriptor_c, descriptor_d, orden
       FROM criterio_config WHERE version = 1 AND criterio_id IN ('presupuesto', 'urgencia')`,
    );
    await expect(cargarConfig(db)).rejects.toThrow(/Configuración incompleta/);
    await expect(recalcularTodos(db)).rejects.toThrow(/Configuración incompleta/);
  });
});
