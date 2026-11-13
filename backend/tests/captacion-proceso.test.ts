// Núcleo de proceso de una llamada (captación ABCD): vincular → enmascarar → modelo → validar y guardar.
// El «modelo» es una función que devuelve el JSON que cada prueba programa; no hay red ni ClickUp.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RespuestaModelo } from '../netelip/calificador/modelo.ts';
import { evaluarLlamadaCaptacion, interaccionDe, type Dependencias, type EntradaLlamada } from '../netelip/captacion/proceso.ts';
import { VERSION_PROMPT } from '../netelip/captacion/prompt.ts';
import type { Db } from '../netelip/captacion/repositorio.ts';
import { ensureCaptacion } from '../netelip/captacion/schema.ts';
import type { LeadCandidato } from '../netelip/captacion/vinculacion.ts';
import { abrirBaseAislada, hayBaseDePruebas, type BaseAislada } from './helpers/captacion-base.ts';

const LEADS: LeadCandidato[] = [
  { clickupTaskId: 'lead-ana', esTareaPadre: true, telefono: '+34 600 111 222', email: 'ana@example.com' },
  { clickupTaskId: 'lead-bea', esTareaPadre: true, telefono: '+34 611 333 444', email: null },
  { clickupTaskId: 'lead-bea-bis', esTareaPadre: true, telefono: '611333444', email: null },
  { clickupTaskId: 'sub-1', esTareaPadre: false, telefono: '+34 622 555 666', email: null },
  { clickupTaskId: 'lead-carlos', esTareaPadre: true, telefono: null, email: 'Carlos@Example.com' },
];
const NOMBRES: Record<string, string> = { 'lead-ana': 'Ana Beltrán', 'lead-carlos': 'Carlos Ruiz' };

const FRASE = {
  presupuesto: 'Tenemos pensado entre noventa y ciento diez mil euros para la obra',
  urgencia: 'La idea es empezar en unos dos meses, en cuanto firmemos la compra',
  decisor: 'Lo decidimos mi marido y yo, y los dos lo tenemos clarísimo',
};
const TRANSCRIPCION = [
  '[00:00:05] GRUPO LYN: Hola Ana, soy Laura de Grupo LYN, te llamo por la reforma que nos consultaste.',
  `[00:01:10] CLIENTE: ${FRASE.urgencia}.`,
  `[00:01:40] CLIENTE: ${FRASE.decisor}.`,
  `[00:02:10] CLIENTE: ${FRASE.presupuesto}.`,
].join('\n');

const NE = { nivel: 'NE', cita: null, marca_tiempo: null };
/** Salida del modelo con tres criterios con cita, el presupuesto en rango y el resto sin información. */
function salida(interaccionId: string, extra: { citaDecisor?: string } = {}): string {
  return JSON.stringify({
    interaccion_id: interaccionId,
    presupuesto: { detectado: true, tipo: 'rango', min: 90000, max: 110000, moneda: 'EUR', emisor: 'cliente', cita: FRASE.presupuesto, marca_tiempo: '00:02:10' },
    presupuesto_insuficiente_sin_solucion: { valor: false, cita: null, marca_tiempo: null },
    criterios: {
      presupuesto: { nivel: 'A', cita: FRASE.presupuesto, marca_tiempo: '00:02:10' },
      urgencia: { plazo_meses: 2, cita: FRASE.urgencia, marca_tiempo: '00:01:10' },
      decisor: { nivel: 'A', cita: extra.citaDecisor ?? FRASE.decisor, marca_tiempo: '00:01:40' },
      alcance: NE, actitud: NE, encaje_lyn: NE, predisposicion_f2f3: NE,
    },
    resumen: { que_quiere: '', donde_quedo: '', que_lo_frena: '', para_que_llamarlo: '', fecha_prevista: null },
  });
}

const llamada = (extra: Partial<EntradaLlamada> = {}): EntradaLlamada => ({
  llamadaId: '77', telefonoE164: '+34600111222', ocurridaEn: new Date('2026-11-10T23:30:00Z'), direccion: 'outbound',
  duracionSegundos: 240, transcripcion: TRANSCRIPCION, ...extra,
});

interface Prueba { deps: Dependencias; usos: string[]; prompts: Array<{ system: string; user: string }> }
/** Dependencias de prueba: registra el orden en que se usan el modelo y la base y los textos que salen hacia el modelo. */
function montar(conDb: Dependencias['conDb'], modelo: (user: string) => string | Error = (user) => salida(/interaccion_id (\S+)/.exec(user)![1]!)): Prueba {
  const usos: string[] = [];
  const prompts: Array<{ system: string; user: string }> = [];
  return {
    usos,
    prompts,
    deps: {
      leads: LEADS,
      nombreLead: (id) => NOMBRES[id] ?? null,
      evaluar: async (system, user): Promise<RespuestaModelo> => {
        usos.push('modelo');
        prompts.push({ system, user });
        const r = modelo(user);
        if (r instanceof Error) throw r;
        return { text: r, model: 'gemini-falso', inputTokens: 1200, outputTokens: 300 };
      },
      conDb: async (fn) => {
        usos.push('db');
        return conDb(fn);
      },
    },
  };
}
const sinDb: Dependencias['conDb'] = () => { throw new Error('no debía tocar la base de datos'); };

describe('captación · proceso · lo que NO llega al modelo ni a la base', () => {
  it.each([
    ['número oculto', { telefonoE164: null }, 'sin_datos'],
    ['teléfono que no es de ningún lead', { telefonoE164: '+34699000111' }, 'sin_coincidencia'],
    ['teléfono repetido en dos leads', { telefonoE164: '+34611333444' }, 'varias_coincidencias'],
    ['teléfono de una subtarea', { telefonoE164: '+34622555666' }, 'sin_coincidencia'],
  ] as const)('%s → sin lead, sin llamar al modelo ni a la base', async (_n, cambio, motivo) => {
    const p = montar(sinDb);
    expect(await evaluarLlamadaCaptacion(p.deps, llamada(cambio))).toEqual({ estado: 'sin_lead', motivo });
    expect(p.usos).toEqual([]);
  });

  it('sin transcripción: sin conversación, sin llamar al modelo ni a la base', async () => {
    const p = montar(sinDb);
    expect(await evaluarLlamadaCaptacion(p.deps, llamada({ transcripcion: '  \n ' }))).toEqual({ estado: 'sin_conversacion' });
    expect(p.usos).toEqual([]);
  });

  it('el modelo falla: se devuelve el fallo (con el texto recortado) y no se toca la base', async () => {
    const p = montar(sinDb, () => new Error('x'.repeat(900)));
    const r = await evaluarLlamadaCaptacion(p.deps, llamada());
    expect(r).toMatchObject({ estado: 'modelo_fallo', clickupTaskId: 'lead-ana' });
    expect((r as { error: string }).error).toHaveLength(500);
    expect(p.usos).toEqual(['modelo']);
  });

  it('el nombre del lead y su teléfono no salen hacia el modelo; los demás datos sí', async () => {
    const p = montar(sinDb, () => new Error('corta aquí'));
    await evaluarLlamadaCaptacion(p.deps, llamada({ transcripcion: `${TRANSCRIPCION}\n[00:03:00] CLIENTE: Soy Ana Beltrán y mi móvil es 600 111 222.` }));
    const { system, user } = p.prompts[0]!;
    expect(user).not.toContain('Beltrán');
    expect(user).not.toContain('600 111 222');
    expect(user).toContain(FRASE.presupuesto);
    expect(system).toContain(VERSION_PROMPT);
  });

  it('el prompt lleva el id de la interacción, el sentido, la fecha de Madrid y los minutos', async () => {
    const p = montar(sinDb, () => new Error('corta aquí'));
    await evaluarLlamadaCaptacion(p.deps, llamada({ llamadaId: '1234', direccion: 'inbound', duracionSegundos: 190, ocurridaEn: new Date('2026-11-10T23:30:00Z') }));
    expect(p.prompts[0]!.user).toContain('interaccion_id netelip:1234 · llamada entrante del 2026-11-11 · 3 min');
    expect(interaccionDe('1234')).toBe('netelip:1234');
  });

  it('el teléfono manda sobre el email y, sin teléfono, vale el email (sin distinguir mayúsculas)', async () => {
    const p = montar(sinDb, () => new Error('corta aquí'));
    await evaluarLlamadaCaptacion(p.deps, llamada({ telefonoE164: null, email: 'carlos@example.COM' }));
    expect(p.usos).toEqual(['modelo']);
    expect(p.prompts[0]!.user).toContain('interaccion_id netelip:77');
  });
});

describe.skipIf(!hayBaseDePruebas)('captación · proceso · con base de datos', () => {
  let base: BaseAislada;
  let conDb: Dependencias['conDb'];
  beforeEach(async () => {
    base = await abrirBaseAislada();
    await ensureCaptacion(base);
    conDb = (fn) => fn(base as unknown as Db);
  });
  afterEach(async () => {
    await base.cerrar();
  });
  const contar = async (tabla: string): Promise<number> => Number((await base.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabla}`)).rows[0]?.n);

  it('llamada completa: lead vinculado, 7 criterios, presupuesto, categoría y lo que se escribiría en ClickUp', async () => {
    const p = montar(conDb);
    const r = await evaluarLlamadaCaptacion(p.deps, llamada());
    expect(r).toMatchObject({
      estado: 'procesada', clickupTaskId: 'lead-ana', via: 'telefono', nuevo: true, modelo: 'gemini-falso', tokens: [1200, 300], versionPrompt: VERSION_PROMPT, revisionManual: [], descartes: [],
    });
    if (r.estado !== 'procesada') throw new Error('no procesada');
    // Pres A (25) + Urg A (25: 2 meses) + Dec A (15) = 65 % de cobertura, todo A → A; 100.000 € vigentes (centro del rango) y Pres A → A+.
    expect(r.categoria).toBe('A+');
    expect(r.escrituras).toMatchObject({ categoria: 'A+', presupuesto: 100000, ponderado: 100000, fuente_presupuesto: 'Llamada' });
    expect(r.escrituras.desglose).toContain('cob. 65 %');
    expect(p.usos).toEqual(['modelo', 'db']);
    expect(await contar('lead_criterio_evaluacion')).toBe(7);
    expect(await contar('lead_presupuesto_evento')).toBe(1);
    const hist = await base.query<{ clickup_task_id: string; motivo: string; categoria: string }>('SELECT clickup_task_id, motivo, categoria FROM lead_calificacion_historial');
    expect(hist.rows).toEqual([{ clickup_task_id: 'lead-ana', motivo: 'evaluacion_ia', categoria: 'A+' }]);
    const inter = await base.query<{ interaccion_id: string }>('SELECT DISTINCT interaccion_id FROM lead_criterio_evaluacion');
    expect(inter.rows).toEqual([{ interaccion_id: 'netelip:77' }]);
    const fecha = await base.query<{ f: string }>("SELECT to_char(fecha_interaccion AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI') AS f FROM lead_presupuesto_evento");
    expect(fecha.rows[0]?.f).toBe('2026-11-10T23:30');
  });

  it('el modelo se consulta ANTES de abrir la base: no se retiene una conexión mientras contesta', async () => {
    const p = montar(conDb);
    await evaluarLlamadaCaptacion(p.deps, llamada());
    expect(p.usos).toEqual(['modelo', 'db']);
  });

  it('procesar dos veces la misma llamada no duplica nada ni añade histórico', async () => {
    const p = montar(conDb);
    const primera = await evaluarLlamadaCaptacion(p.deps, llamada());
    const segunda = await evaluarLlamadaCaptacion(p.deps, llamada());
    expect(primera).toMatchObject({ estado: 'procesada', nuevo: true });
    expect(segunda).toMatchObject({ estado: 'procesada', nuevo: false, categoria: 'A+' });
    expect(await contar('lead_criterio_evaluacion')).toBe(7);
    expect(await contar('lead_presupuesto_evento')).toBe(1);
    expect(await contar('lead_calificacion_historial')).toBe(1);
  });

  it('una cita que no aparece en la transcripción se descarta: el criterio queda sin información y consta el descarte', async () => {
    const p = montar(conDb, (user) => salida(/interaccion_id (\S+)/.exec(user)![1]!, { citaDecisor: 'Decide mi suegra por todos nosotros siempre' }));
    const r = await evaluarLlamadaCaptacion(p.deps, llamada());
    if (r.estado !== 'procesada') throw new Error('no procesada');
    expect(r.descartes.length).toBeGreaterThan(0);
    expect(r.escrituras.desglose).toContain('Dec NE');
    expect(r.escrituras.desglose).toContain('cob. 50 %');
  });

  it('una respuesta que no cumple el contrato no guarda nada y devuelve el lead', async () => {
    const p = montar(conDb, () => 'esto no es JSON');
    const r = await evaluarLlamadaCaptacion(p.deps, llamada());
    expect(r).toEqual({ estado: 'salida_invalida', error: 'la respuesta no es JSON', clickupTaskId: 'lead-ana' });
    for (const tabla of ['lead_criterio_evaluacion', 'lead_presupuesto_evento', 'lead_no_apto_evento', 'lead_calificacion_historial']) expect(await contar(tabla)).toBe(0);
  });

  it('la salida de OTRA llamada (interaccion_id distinto) se rechaza', async () => {
    const p = montar(conDb, () => salida('netelip:999'));
    const r = await evaluarLlamadaCaptacion(p.deps, llamada());
    expect(r).toMatchObject({ estado: 'salida_invalida', clickupTaskId: 'lead-ana' });
    expect(await contar('lead_criterio_evaluacion')).toBe(0);
  });

  it('las citas se comprueban contra la transcripción ENMASCARADA, la que vio el modelo', async () => {
    const citaConMarcador = 'Me llamo [NOMBRE] y lo decidimos juntos mi marido y yo';
    const transcripcion = `${TRANSCRIPCION}\n[00:03:00] CLIENTE: Me llamo Ana Beltrán y lo decidimos juntos mi marido y yo.`;
    const p = montar(conDb, (user) => salida(/interaccion_id (\S+)/.exec(user)![1]!, { citaDecisor: citaConMarcador }));
    const r = await evaluarLlamadaCaptacion(p.deps, llamada({ transcripcion }));
    if (r.estado !== 'procesada') throw new Error('no procesada');
    expect(p.prompts[0]!.user).toContain('Me llamo [NOMBRE] y lo decidimos');
    expect(r.descartes).toEqual([]);
    expect(r.escrituras.desglose).toContain('Dec A');
  });

  it('lo que queda para revisión manual llega al resultado (No apto señalado sin una cita verificable)', async () => {
    const conNoApto = (user: string) => {
      const s = JSON.parse(salida(/interaccion_id (\S+)/.exec(user)![1]!));
      s.presupuesto_insuficiente_sin_solucion = { valor: true, cita: 'No llegamos ni a la mitad de eso en ningún caso', marca_tiempo: '00:02:30' };
      return JSON.stringify(s);
    };
    const p = montar(conDb, conNoApto);
    const r = await evaluarLlamadaCaptacion(p.deps, llamada());
    if (r.estado !== 'procesada') throw new Error('no procesada');
    expect(r.revisionManual).toEqual(['presupuesto insuficiente sin solución señalado sin una cita verificable']);
    expect(r.categoria).toBe('A+');
  });

  it('dos leads distintos en la misma base no se mezclan', async () => {
    const p = montar(conDb);
    await evaluarLlamadaCaptacion(p.deps, llamada({ llamadaId: '1', telefonoE164: '+34600111222' }));
    expect(await evaluarLlamadaCaptacion(p.deps, llamada({ llamadaId: '2', telefonoE164: null, email: 'carlos@example.com' }))).toMatchObject({ clickupTaskId: 'lead-carlos', via: 'email' });
    const filas = await base.query<{ clickup_task_id: string; n: number }>('SELECT clickup_task_id, count(*)::int AS n FROM lead_criterio_evaluacion GROUP BY 1 ORDER BY 1');
    expect(filas.rows).toEqual([{ clickup_task_id: 'lead-ana', n: 7 }, { clickup_task_id: 'lead-carlos', n: 7 }]);
  });
});
