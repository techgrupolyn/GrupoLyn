// N-1.3 · Resumen ejecutivo del lead en 4 bloques tras cada interacción (ticket 869fny1ek).
// Parte pura (validación), capa de datos, escritura a ClickUp y los escenarios de aceptación de punta a punta
// (llamada → modelo programado → base → lo que se escribiría en ClickUp). Sin red.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RespuestaModelo } from '../netelip/calificador/modelo.ts';
import { escribirPlan, NOMBRES_CAMPOS, planEscritura, type CampoLista } from '../netelip/captacion/clickup.ts';
import type { EscriturasConTextos } from '../netelip/captacion/motor.ts';
import { evaluarLlamadaCaptacion, type Dependencias, type EntradaLlamada } from '../netelip/captacion/proceso.ts';
import {
  BLOQUES_RESUMEN, contieneDatoDeContacto, contieneImporte, fechaMadrid, MAX_CARACTERES_RESUMEN, PREGUNTAR_PRESUPUESTO, renderResumen,
  SIN_FECHA_ACORDADA, SIN_INFORMACION, validarResumen, type ContextoResumen,
} from '../netelip/captacion/resumen.ts';
import {
  cargarResumenVigente, recalcularLead, registrarPresupuestoFormulario, registrarResumenLlamada, type Db,
} from '../netelip/captacion/repositorio.ts';
import { ensureCaptacion } from '../netelip/captacion/schema.ts';
import type { ResumenSalida } from '../netelip/captacion/salida-modelo.ts';
import type { LeadCandidato } from '../netelip/captacion/vinculacion.ts';
import { abrirBaseAislada, hayBaseDePruebas, type BaseAislada } from './helpers/captacion-base.ts';
import { CITA_FECHA, RESUMEN_BUENO, salidaModelo, TRANSCRIPCION_BASE, TRANSCRIPCION_CON_FECHA, type OpcionesSalida } from './helpers/captacion-llamadas.ts';

// ---------------------------------------------------------------------------------------------
// Validación (pura)
// ---------------------------------------------------------------------------------------------

const resumen = (o: Partial<ResumenSalida> = {}): ResumenSalida => ({
  queQuiere: 'Reforma integral de un piso',
  dondeQuedo: 'Vendrá a la oficina el viernes',
  queLoFrena: 'Falta firmar la compra',
  paraQueLlamarlo: 'Confirmar la visita',
  fechaPrevista: '2026-11-20',
  fechaCita: CITA_FECHA,
  ...o,
});
const ctx = (o: Partial<ContextoResumen> = {}): ContextoResumen => ({
  transcripcion: TRANSCRIPCION_CON_FECHA, fechaLlamada: '2026-11-17', tienePresupuesto: true, ...o,
});
const ok = (r: ResumenSalida, c: ContextoResumen = ctx()) => {
  const v = validarResumen(r, c);
  if (!v.ok) throw new Error(`debía valer: ${v.detalle}`);
  return v.resumen;
};
const invalido = (r: ResumenSalida, c: ContextoResumen = ctx()): string => {
  const v = validarResumen(r, c);
  if (v.ok) throw new Error('debía ser inválido');
  return v.detalle;
};

describe('validarResumen · lo que vale', () => {
  it('un resumen correcto se queda tal cual y se escribe en 4 líneas con etiqueta, en el orden de Alex', () => {
    const r = ok(resumen());
    expect(r).toEqual({ queQuiere: 'Reforma integral de un piso', dondeQuedo: 'Vendrá a la oficina el viernes', queLoFrena: 'Falta firmar la compra', paraQueLlamarlo: 'Confirmar la visita', fechaPrevista: '2026-11-20' });
    expect(renderResumen(r)).toBe(
      'Qué quiere: Reforma integral de un piso\nDónde quedó: Vendrá a la oficina el viernes\nQué lo frena: Falta firmar la compra\nPara qué llamarlo: Confirmar la visita',
    );
    expect(BLOQUES_RESUMEN.map((b) => b.etiqueta)).toEqual(['Qué quiere', 'Dónde quedó', 'Qué lo frena', 'Para qué llamarlo']);
  });

  it('cada bloque va en una sola línea: los saltos de línea y los espacios de más se recogen', () => {
    const r = ok(resumen({ queQuiere: '  Reforma\n  integral\r\n de   un piso ' }));
    expect(r.queQuiere).toBe('Reforma integral de un piso');
    expect(renderResumen(r).split('\n')).toHaveLength(4);
  });

  it('un bloque sin texto pasa a «Sin información»; con los cuatro vacíos no hay resumen', () => {
    expect(ok(resumen({ queLoFrena: '' })).queLoFrena).toBe(SIN_INFORMACION);
    expect(ok(resumen({ queLoFrena: ' \n ' })).queLoFrena).toBe(SIN_INFORMACION);
    const vacio = validarResumen(resumen({ queQuiere: '', dondeQuedo: ' ', queLoFrena: '', paraQueLlamarlo: '\n' }), ctx());
    expect(vacio).toEqual({ ok: false, motivo: 'vacio', detalle: 'el resumen viene vacío' });
    // Con uno solo de los cuatro basta para que sea un resumen.
    expect(validarResumen(resumen({ queQuiere: '', dondeQuedo: '', queLoFrena: '', paraQueLlamarlo: 'Llamar' }), ctx()).ok).toBe(true);
  });

  it('el texto completo, con sus etiquetas, puede llegar a 600 caracteres y no pasa de ahí', () => {
    // 61 caracteres de etiquetas y saltos de línea + 539 de texto = 600.
    const justo = resumen({ queQuiere: 'a'.repeat(200), dondeQuedo: 'b'.repeat(100), queLoFrena: 'c'.repeat(100), paraQueLlamarlo: 'd'.repeat(139) });
    expect(renderResumen(ok(justo)).length).toBe(MAX_CARACTERES_RESUMEN);
    const demasiado = resumen({ queQuiere: 'a'.repeat(200), dondeQuedo: 'b'.repeat(100), queLoFrena: 'c'.repeat(100), paraQueLlamarlo: 'd'.repeat(140) });
    expect(invalido(demasiado)).toBe('el resumen tiene 601 caracteres (máximo 600)');
  });

  it('lo que el sistema añade a «Para qué llamarlo» también cuenta para los 600 caracteres', () => {
    const casiLleno = resumen({ queQuiere: 'a'.repeat(200), dondeQuedo: 'b'.repeat(100), queLoFrena: 'c'.repeat(100), paraQueLlamarlo: 'd'.repeat(139), fechaPrevista: null, fechaCita: null });
    expect(invalido(casiLleno, ctx({ tienePresupuesto: true }))).toMatch(/caracteres \(máximo 600\)/);
  });
});

describe('validarResumen · sin importes', () => {
  it.each([
    'Tiene unos 90.000 euros', 'Presupuesto de 40k', 'Maneja cien mil', 'Piensa en 500 euros', 'Gasta hasta 80 € en total', 'Entre 40 y 70 mil',
    'Cuenta con 100000', 'Quiere 2 millones', 'Habla de 1,500 de más', 'Un millón largo', 'Pone 30 EUR', 'Tiene 12 K',
  ])('rechaza «%s»', (texto) => {
    expect(contieneImporte(texto)).toBe(true);
    expect(invalido(resumen({ queLoFrena: texto }))).toBe('«Qué lo frena» menciona un importe');
  });

  it.each([
    'Reforma de 100 m²', 'Piso de 80 m2 con 2 baños', 'Quiere empezar en 2 meses', 'Vendrá el viernes 20 a las seis', 'Compra en el año 2026',
    'Su familia decide', 'Sin información', 'Presupuesto ajustado, aún no da cifra', 'Reforma militar de un local', 'Llamar el 2026-11-20',
  ])('deja pasar «%s»', (texto) => {
    expect(contieneImporte(texto)).toBe(false);
  });

  it('nombra el bloque que lo lleva, sea cual sea', () => {
    expect(invalido(resumen({ queQuiere: 'Cocina de 20.000 euros' }))).toBe('«Qué quiere» menciona un importe');
    expect(invalido(resumen({ dondeQuedo: 'Dijo 90.000' }))).toBe('«Dónde quedó» menciona un importe');
    expect(invalido(resumen({ paraQueLlamarlo: 'Hablar de 5 mil' }))).toBe('«Para qué llamarlo» menciona un importe');
  });
});

describe('validarResumen · sin datos de contacto', () => {
  it.each([
    'Escribir a ana@example.com', 'Su móvil es 600 111 222', 'Llamar al +34 600 111 222', 'Es 600-111-222', 'Hablar con [NOMBRE]', 'Vive en calle Mayor 5',
    'Obra en Avenida de Europa', 'Local en C/ Gran Vía', 'Piso en C/Alcalá 12, 3ºB', 'Vive en c/Mayor', 'Vive en calle mayor 5', 'Obra en la avenida de la constitución 12, 3ºB', 'Local en plaza mayor 4 piso 2', 'Es la calle del olmo 7.', 'Piso en Plaza Mayor', 'Casa en la calle 5', 'Su email [EMAIL]', 'Vive en Calle de la Paz', 'Obra en el Paseo del Prado',
  ])('rechaza «%s»', (texto) => {
    expect(contieneDatoDeContacto(texto)).toBe(true);
    expect(invalido(resumen({ dondeQuedo: texto }))).toBe('«Dónde quedó» lleva un dato de contacto');
  });

  it('un teléfono escrito con puntos también se rechaza (lo mismo parece un importe que un teléfono)', () => {
    expect(contieneDatoDeContacto('Teléfono 965.123.456')).toBe(true);
    expect(validarResumen(resumen({ dondeQuedo: 'Teléfono 965.123.456' }), ctx()).ok).toBe(false);
  });

  it.each([
    'Vendrá el 2026-11-20 a las seis', 'Quedó en llamar en 2 semanas', 'Vive en una calle ruidosa', 'Quiere una plaza de garaje', 'Reforma de 100 m² y 2 baños',
    'Sin información', 'Camino de la obra largo', 'Cuenta c/u un baño', 'Quiere plaza de garaje para 2 coches', 'Camino de la obra 2 meses', 'Una calle ruidosa y estrecha', 'Citas 2026-11-20 2026-11-27', 'Medidas 12 34 56 78', 'Reforma del camino viejo 2026',
  ])('deja pasar «%s»', (texto) => {
    expect(contieneDatoDeContacto(texto)).toBe(false);
  });
});

describe('validarResumen · la fecha prevista', () => {
  it('con fecha real, de la llamada en adelante y con una cita literal de la transcripción, vale (y no añade «sin fecha acordada»)', () => {
    const r = ok(resumen({ fechaPrevista: '2026-11-20' }));
    expect(r.fechaPrevista).toBe('2026-11-20');
    expect(r.paraQueLlamarlo).not.toContain(SIN_FECHA_ACORDADA);
  });

  it('el mismo día de la llamada vale; el día anterior no', () => {
    expect(ok(resumen({ fechaPrevista: '2026-11-17' })).fechaPrevista).toBe('2026-11-17');
    expect(invalido(resumen({ fechaPrevista: '2026-11-16' }))).toBe('la fecha prevista es anterior a la llamada');
  });

  it.each(['2026-02-30', '2026-13-01', '20-11-2026', 'viernes', '2026-11-2', '2026-11-20T10:00'])('«%s» no es una fecha AAAA-MM-DD válida', (f) => {
    expect(invalido(resumen({ fechaPrevista: f }))).toBe('la fecha prevista no es una fecha AAAA-MM-DD válida');
  });

  it('la cita de la fecha tiene que hablar de una fecha o un plazo: «te llamo cuando pueda» no respalda ninguna fecha', () => {
    const vaga = 'Tengo que consultarlo, te llamo cuando pueda';
    const c = ctx({ transcripcion: `[00:01:00] CLIENTE: ${vaga}.` });
    expect(invalido(resumen({ fechaPrevista: '2026-11-20', fechaCita: vaga }), c)).toBe('la cita de la fecha prevista no menciona ninguna fecha ni plazo');
    for (const buena of ['Te llamo el viernes por la tarde', 'Mejor la semana que viene sin falta', 'Nos vemos mañana a primera hora', 'Hablamos el 20 de noviembre', 'El 20 va bien', 'Quedamos la próxima vez que pases']) {
      expect(ok(resumen({ fechaPrevista: '2026-11-20', fechaCita: buena }), ctx({ transcripcion: `[00:01:00] CLIENTE: ${buena}.` })).fechaPrevista, buena).toBe('2026-11-20');
    }
  });

  it('una fecha a más de 400 días de la llamada es casi seguro un error: 400 valen, 401 no', () => {
    expect(ok(resumen({ fechaPrevista: '2027-12-22' })).fechaPrevista).toBe('2027-12-22');
    expect(invalido(resumen({ fechaPrevista: '2027-12-23' }))).toBe('la fecha prevista queda a más de 400 días de la llamada');
    expect(invalido(resumen({ fechaPrevista: '2034-01-01' }))).toBe('la fecha prevista queda a más de 400 días de la llamada');
  });

  it('sin cita, o con una cita que no está en la llamada o es demasiado corta, no vale: la fecha nunca se inventa', () => {
    const mensaje = 'la fecha prevista no trae una cita verificable de la llamada';
    expect(invalido(resumen({ fechaCita: null }))).toBe(mensaje);
    expect(invalido(resumen({ fechaCita: 'Quedamos el sábado por la mañana en la obra' }))).toBe(mensaje);
    expect(invalido(resumen({ fechaCita: 'el viernes veinte' }))).toBe(mensaje);
  });

  it('sin fecha acordada, «Para qué llamarlo» lo dice; si ya lo dice no se repite', () => {
    const r = ok(resumen({ fechaPrevista: null, fechaCita: null, paraQueLlamarlo: 'Proponer una llamada con los dos' }));
    expect(r.fechaPrevista).toBeNull();
    expect(r.paraQueLlamarlo).toBe('Proponer una llamada con los dos; sin fecha acordada');
    expect(ok(resumen({ fechaPrevista: null, fechaCita: null, paraQueLlamarlo: 'Llamar. Sin fecha acordada' })).paraQueLlamarlo).toBe('Llamar. Sin fecha acordada');
  });

  it('una cita suelta sin fecha se ignora (la fecha manda): queda «sin fecha acordada»', () => {
    expect(ok(resumen({ fechaPrevista: null, fechaCita: CITA_FECHA })).paraQueLlamarlo).toContain(SIN_FECHA_ACORDADA);
  });
});

describe('validarResumen · lo que añade el sistema', () => {
  it('sin presupuesto registrado, «Para qué llamarlo» lleva «Preguntar presupuesto» (antes de «sin fecha acordada»)', () => {
    const c = ctx({ tienePresupuesto: false });
    expect(ok(resumen(), c).paraQueLlamarlo).toBe(`Confirmar la visita; ${PREGUNTAR_PRESUPUESTO}`);
    expect(ok(resumen({ fechaPrevista: null, fechaCita: null }), c).paraQueLlamarlo).toBe('Confirmar la visita; Preguntar presupuesto; sin fecha acordada');
  });

  it('si el lead no tiene presupuesto, «No preguntar presupuesto» contradice lo que pide el ticket: el resumen no vale', () => {
    const c = ctx({ tienePresupuesto: false });
    const mensaje = '«Para qué llamarlo» dice que no se pregunte el presupuesto y el lead no tiene ninguno';
    expect(invalido(resumen({ paraQueLlamarlo: 'No preguntar presupuesto todavía' }), c)).toBe(mensaje);
    expect(invalido(resumen({ paraQueLlamarlo: 'No hace falta preguntar presupuesto' }), c)).toBe(mensaje);
    // Con presupuesto registrado es verdad y vale; un «no» de otra frase no cuenta.
    expect(validarResumen(resumen({ paraQueLlamarlo: 'No preguntar presupuesto todavía' }), ctx({ tienePresupuesto: true })).ok).toBe(true);
    expect(ok(resumen({ paraQueLlamarlo: 'No llamar hoy. Preguntar presupuesto' }), c).paraQueLlamarlo).toBe('No llamar hoy. Preguntar presupuesto');
  });

  it('con presupuesto registrado no lo añade, y si el modelo ya lo puso no se repite', () => {
    expect(ok(resumen(), ctx({ tienePresupuesto: true })).paraQueLlamarlo).toBe('Confirmar la visita');
    expect(ok(resumen({ paraQueLlamarlo: 'Preguntar presupuesto en la visita' }), ctx({ tienePresupuesto: false })).paraQueLlamarlo).toBe('Preguntar presupuesto en la visita');
  });

  it('un último bloque sin información lo sustituye la indicación, con mayúscula inicial', () => {
    expect(ok(resumen({ paraQueLlamarlo: '' }), ctx({ tienePresupuesto: false })).paraQueLlamarlo).toBe('Preguntar presupuesto');
    expect(ok(resumen({ paraQueLlamarlo: SIN_INFORMACION, fechaPrevista: null, fechaCita: null }), ctx({ tienePresupuesto: true })).paraQueLlamarlo).toBe('Sin fecha acordada');
  });

  it('quita la puntuación final antes de añadir', () => {
    expect(ok(resumen({ paraQueLlamarlo: 'Llamar el jueves.', fechaPrevista: null, fechaCita: null })).paraQueLlamarlo).toBe('Llamar el jueves; sin fecha acordada');
    expect(ok(resumen({ paraQueLlamarlo: 'Llamar el jueves ; ', fechaPrevista: null, fechaCita: null })).paraQueLlamarlo).toBe('Llamar el jueves; sin fecha acordada');
  });
});

describe('fechaMadrid', () => {
  it('da el día en hora de Madrid, no en UTC', () => {
    expect(fechaMadrid(new Date('2026-11-10T23:30:00Z'))).toBe('2026-11-11');
    expect(fechaMadrid(new Date('2026-11-10T10:00:00Z'))).toBe('2026-11-10');
    expect(fechaMadrid(new Date('2026-07-10T22:30:00Z'))).toBe('2026-07-11');
  });
});

// ---------------------------------------------------------------------------------------------
// Escritura a ClickUp: el campo «Resumen ejecutivo»
// ---------------------------------------------------------------------------------------------

const opciones = (nombres: string[]) => nombres.map((name, i) => ({ id: `op-${name}`, name, orderindex: i }));
const CAMPOS_BASE: CampoLista[] = [
  { id: 'f-cat', name: NOMBRES_CAMPOS.categoria, type: 'drop_down', opciones: opciones(['A+', 'A', 'B', 'C', 'D', 'Sin calificar', 'No apto']) },
  { id: 'f-pres', name: NOMBRES_CAMPOS.presupuesto, type: 'currency', opciones: [] },
  { id: 'f-pond', name: NOMBRES_CAMPOS.ponderado, type: 'currency', opciones: [] },
  { id: 'f-fuente', name: NOMBRES_CAMPOS.fuente_presupuesto, type: 'drop_down', opciones: opciones(['Formulario', 'Llamada']) },
  { id: 'f-idx', name: NOMBRES_CAMPOS.indice_orden, type: 'number', opciones: [] },
  { id: 'f-des', name: NOMBRES_CAMPOS.desglose, type: 'short_text', opciones: [] },
];
const CAMPO_RESUMEN: CampoLista = { id: 'f-res', name: NOMBRES_CAMPOS.resumen, type: 'text', opciones: [] };
const esc = (o: Partial<EscriturasConTextos> = {}): EscriturasConTextos => ({
  categoria: 'B', presupuesto: 70000, ponderado: 52500, fuente_presupuesto: 'Formulario', desglose: 'Pres A · Urg B', ...o,
});

describe('planEscritura · «Resumen ejecutivo»', () => {
  it('el campo se llama «Resumen ejecutivo»', () => {
    expect(NOMBRES_CAMPOS.resumen).toBe('Resumen ejecutivo');
  });

  it('con resumen y con el campo en la lista, lo escribe al final', () => {
    const texto = 'Qué quiere: x\nDónde quedó: y';
    const plan = planEscritura(esc({ resumen: texto }), [...CAMPOS_BASE, CAMPO_RESUMEN]);
    expect(plan.cambios.at(-1)).toEqual({ clave: 'resumen', campoId: 'f-res', valor: texto });
    expect(plan.omitidos).toEqual([]);
  });

  it('con resumen pero sin el campo en la lista, no escribe el resumen, lo anota y escribe el resto igual', () => {
    const plan = planEscritura(esc({ resumen: 'x' }), CAMPOS_BASE);
    expect(plan.cambios.map((c) => c.clave)).toEqual(['categoria', 'fuente_presupuesto', 'presupuesto', 'ponderado', 'indice_orden', 'desglose']);
    expect(plan.omitidos).toEqual(['resumen (el campo no existe en la lista)']);
  });

  it('sin resumen (el lead aún no tiene uno) no toca el campo ni lo anota, aunque exista', () => {
    const plan = planEscritura(esc(), [...CAMPOS_BASE, CAMPO_RESUMEN]);
    expect(plan.cambios.map((c) => c.clave)).not.toContain('resumen');
    expect(plan.omitidos).toEqual([]);
  });

  it('se escribe con un POST al campo, con el texto tal cual (los saltos de línea incluidos)', async () => {
    const hechos: Array<[string, string, string | number]> = [];
    const texto = 'Qué quiere: x\nDónde quedó: y';
    const plan = planEscritura(esc({ resumen: texto }), [...CAMPOS_BASE, CAMPO_RESUMEN]);
    await escribirPlan({ escribirCampo: async (t, c, v) => { hechos.push([t, c, v]); } }, 'T1', plan);
    expect(hechos.at(-1)).toEqual(['T1', 'f-res', texto]);
  });
});

// ---------------------------------------------------------------------------------------------
// Capa de datos y recorrido completo contra Postgres
// ---------------------------------------------------------------------------------------------

const LEADS: LeadCandidato[] = [{ clickupTaskId: 'lead-ana', esTareaPadre: true, telefono: '+34 600 111 222', email: null }];

const llamada = (extra: Partial<EntradaLlamada> = {}): EntradaLlamada => ({
  llamadaId: '77', telefonoE164: '+34600111222', ocurridaEn: new Date('2026-11-17T10:00:00Z'), direccion: 'outbound',
  duracionSegundos: 240, transcripcion: TRANSCRIPCION_CON_FECHA, ...extra,
});

describe.skipIf(!hayBaseDePruebas)('resumen ejecutivo contra Postgres', () => {
  let base: BaseAislada;
  let db: Db;
  let conDb: Dependencias['conDb'];
  beforeEach(async () => {
    base = await abrirBaseAislada();
    await ensureCaptacion(base);
    db = base as unknown as Db;
    conDb = (fn) => fn(db);
  });
  afterEach(async () => {
    await base.cerrar();
  });
  const contar = async (tabla: string): Promise<number> => Number((await base.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabla}`)).rows[0]?.n);
  const filas = async () =>
    (await base.query<{ interaccion_id: string; que_quiere: string; fecha_prevista: string | null }>(
      "SELECT interaccion_id, que_quiere, to_char(fecha_prevista, 'YYYY-MM-DD') AS fecha_prevista FROM lead_resumen_historial ORDER BY seq",
    )).rows;

  /** «Modelo» programado: devuelve la salida que cada prueba pide para la llamada (por su interaccion_id) y guarda lo que recibió. */
  function montar(salidas: (interaccionId: string) => string) {
    const prompts: string[] = [];
    const deps: Dependencias = {
      conDb, leads: LEADS, nombreLead: () => null,
      evaluar: async (_system, user): Promise<RespuestaModelo> => {
        prompts.push(user);
        return { text: salidas(/interaccion_id (\S+)/.exec(user)![1]!), model: 'gemini-falso', inputTokens: 1, outputTokens: 1 };
      },
    };
    return { deps, prompts };
  }
  const salida = (resumenModelo: OpcionesSalida['resumen'], extra: OpcionesSalida = {}) => (id: string) =>
    salidaModelo(id, { ...extra, resumen: resumenModelo });

  // --- registrarResumenLlamada / cargarResumenVigente -------------------------------------------------------

  const registro = (o: Partial<Parameters<typeof registrarResumenLlamada>[1]> = {}) => ({
    clickupTaskId: 'T1', interaccionId: 'netelip:1', fechaInteraccion: '2026-11-17T10:00:00.000Z', resumen: resumen(),
    transcripcion: TRANSCRIPCION_CON_FECHA, tienePresupuesto: true, ...o,
  });

  it('guarda el resumen validado (con la fecha prevista como día, sin desplazarla) y repetir la misma llamada conserva el que había', async () => {
    expect(await registrarResumenLlamada(db, registro())).toEqual({ estado: 'guardado' });
    expect(await registrarResumenLlamada(db, registro({ resumen: resumen({ queQuiere: 'Otro texto' }) }))).toEqual({ estado: 'ya_existia' });
    expect(await filas()).toEqual([{ interaccion_id: 'netelip:1', que_quiere: 'Reforma integral de un piso', fecha_prevista: '2026-11-20' }]);
  });

  it('un resumen vacío o inválido no se guarda y dice por qué', async () => {
    expect(await registrarResumenLlamada(db, registro({ resumen: resumen({ queQuiere: '', dondeQuedo: '', queLoFrena: '', paraQueLlamarlo: '' }) }))).toEqual({ estado: 'vacio' });
    expect(await registrarResumenLlamada(db, registro({ resumen: resumen({ queLoFrena: 'Tiene 90.000 euros' }) }))).toEqual({ estado: 'descartado', motivo: '«Qué lo frena» menciona un importe' });
    expect(await contar('lead_resumen_historial')).toBe(0);
  });

  it('la fecha de la llamada para validar es la de Madrid: una llamada de las 23:30 UTC ya es del día siguiente', async () => {
    const r = resumen({ fechaPrevista: '2026-11-11', fechaCita: CITA_FECHA });
    const tarde = registro({ fechaInteraccion: '2026-11-10T23:30:00.000Z', resumen: r });
    expect(await registrarResumenLlamada(db, tarde)).toEqual({ estado: 'guardado' });
    expect(await registrarResumenLlamada(db, { ...tarde, interaccionId: 'netelip:2', resumen: resumen({ fechaPrevista: '2026-11-10' }) })).toMatchObject({ estado: 'descartado', motivo: 'la fecha prevista es anterior a la llamada' });
  });

  it('el vigente es el de la llamada más reciente POR FECHA, no por orden de proceso; con la misma fecha, el último guardado', async () => {
    expect(await cargarResumenVigente(db, 'T1')).toBeNull();
    await registrarResumenLlamada(db, registro({ interaccionId: 'netelip:nueva', fechaInteraccion: '2026-11-17T12:00:00.000Z', resumen: resumen({ queQuiere: 'La nueva' }) }));
    await registrarResumenLlamada(db, registro({ interaccionId: 'netelip:vieja', fechaInteraccion: '2026-11-15T12:00:00.000Z', resumen: resumen({ queQuiere: 'La vieja', fechaPrevista: null, fechaCita: null }) }));
    expect((await cargarResumenVigente(db, 'T1'))?.queQuiere).toBe('La nueva');
    expect(await contar('lead_resumen_historial')).toBe(2);
    await registrarResumenLlamada(db, registro({ interaccionId: 'netelip:misma-fecha', fechaInteraccion: '2026-11-17T12:00:00.000Z', resumen: resumen({ queQuiere: 'Misma fecha, guardada después' }) }));
    expect((await cargarResumenVigente(db, 'T1'))?.queQuiere).toBe('Misma fecha, guardada después');
  });

  it('con «antesDe» solo cuenta lo anterior a esa fecha (es el resumen anterior que se le da al modelo)', async () => {
    await registrarResumenLlamada(db, registro({ interaccionId: 'netelip:a', fechaInteraccion: '2026-11-15T12:00:00.000Z', resumen: resumen({ queQuiere: 'A', fechaPrevista: null, fechaCita: null }) }));
    await registrarResumenLlamada(db, registro({ interaccionId: 'netelip:b', fechaInteraccion: '2026-11-17T12:00:00.000Z', resumen: resumen({ queQuiere: 'B' }) }));
    expect((await cargarResumenVigente(db, 'T1', '2026-11-17T12:00:00.000Z'))?.queQuiere).toBe('A');
    expect((await cargarResumenVigente(db, 'T1', '2026-11-18T00:00:00.000Z'))?.queQuiere).toBe('B');
    expect(await cargarResumenVigente(db, 'T1', '2026-11-15T12:00:00.000Z')).toBeNull();
  });

  it('un lead no ve el resumen de otro', async () => {
    await registrarResumenLlamada(db, registro({ clickupTaskId: 'T1' }));
    expect(await cargarResumenVigente(db, 'T2')).toBeNull();
  });

  it('devuelve la fecha prevista como texto AAAA-MM-DD, o null si no hay', async () => {
    await registrarResumenLlamada(db, registro({ interaccionId: 'netelip:a', resumen: resumen() }));
    expect((await cargarResumenVigente(db, 'T1'))?.fechaPrevista).toBe('2026-11-20');
    await registrarResumenLlamada(db, registro({ interaccionId: 'netelip:b', fechaInteraccion: '2026-11-18T10:00:00.000Z', resumen: resumen({ fechaPrevista: null, fechaCita: null }) }));
    expect((await cargarResumenVigente(db, 'T1'))?.fechaPrevista).toBeNull();
  });

  it('la tabla no admite un bloque vacío ni dos resúmenes de la misma llamada', async () => {
    const insertar = (interaccion: string, queQuiere: string) => base.query(
      `INSERT INTO lead_resumen_historial (clickup_task_id, interaccion_id, que_quiere, donde_quedo, que_lo_frena, para_que_llamarlo, fecha_interaccion)
       VALUES ('T1', $1, $2, 'b', 'c', 'd', now())`,
      [interaccion, queQuiere],
    );
    await expect(insertar('i1', '  ')).rejects.toThrow();
    await insertar('i2', 'ok');
    await expect(insertar('i2', 'otra vez')).rejects.toThrow();
  });

  // --- recalcularLead lleva el resumen vigente a lo que se escribe en ClickUp ------------------------------------

  it('lo que se escribe en ClickUp lleva el resumen vigente solo si el lead tiene uno', async () => {
    await registrarPresupuestoFormulario(db, { clickupTaskId: 'T1', opcion: '40.000 – 100.000 €', fechaInteraccion: '2026-11-10T10:00:00.000Z' });
    const sin = await recalcularLead(db, 'T1', { disparador: 'alta', categoriaElegida: 'B' });
    expect(Object.keys(sin.escrituras)).not.toContain('resumen');
    await registrarResumenLlamada(db, registro());
    const con = await recalcularLead(db, 'T1', { disparador: 'recalculo' });
    expect(con.escrituras.resumen).toBe(renderResumen((await cargarResumenVigente(db, 'T1'))!));
    expect(con.escrituras.resumen!.split('\n')).toHaveLength(4);
  });

  // --- De punta a punta: los escenarios de aceptación del ticket ---------------------------------------------------

  it('Escenario «Resumen tras una llamada»: los 4 bloques en su orden, hasta 5 líneas y 600 caracteres, sin importes', async () => {
    const p = montar(salida(RESUMEN_BUENO));
    const r = await evaluarLlamadaCaptacion(p.deps, llamada());
    if (r.estado !== 'procesada') throw new Error('no procesada');
    expect(r.resumen).toEqual({ estado: 'guardado' });
    const texto = r.escrituras.resumen!;
    const lineas = texto.split('\n');
    expect(lineas.map((l) => l.split(':')[0])).toEqual(['Qué quiere', 'Dónde quedó', 'Qué lo frena', 'Para qué llamarlo']);
    expect(lineas.length).toBeLessThanOrEqual(5);
    expect(texto.length).toBeLessThanOrEqual(600);
    expect(contieneImporte(texto)).toBe(false);
    expect(lineas[3]).toBe('Para qué llamarlo: Confirmar la visita del viernes');
  });

  it('Escenario «Actualización con una nueva interacción»: «Dónde quedó» refleja la última llamada, el anterior queda en el historial y el modelo recibe el resumen previo', async () => {
    const p = montar((id) => salidaModelo(id, { resumen: id === 'netelip:1' ? RESUMEN_BUENO : { ...RESUMEN_BUENO, donde_quedo: 'Confirmó la visita del viernes', fecha_prevista: null, fecha_prevista_cita: null } }));
    await evaluarLlamadaCaptacion(p.deps, llamada({ llamadaId: '1', ocurridaEn: new Date('2026-11-17T10:00:00Z') }));
    const segunda = await evaluarLlamadaCaptacion(p.deps, llamada({ llamadaId: '2', ocurridaEn: new Date('2026-11-18T10:00:00Z') }));
    if (segunda.estado !== 'procesada') throw new Error('no procesada');

    // La primera llamada se procesó sin resumen anterior; la segunda recibió el de la primera, no todo el historial.
    expect(p.prompts[0]).toContain('Resumen anterior del lead: ninguno');
    expect(p.prompts[1]).toContain('Resumen anterior del lead (actualízalo con esta llamada):\nQué quiere: Reforma integral de la vivienda\nDónde quedó: Vendrá a la oficina el viernes a las seis');

    expect(segunda.escrituras.resumen).toContain('Dónde quedó: Confirmó la visita del viernes');
    expect(await filas()).toHaveLength(2);
    expect((await cargarResumenVigente(db, 'lead-ana'))?.dondeQuedo).toBe('Confirmó la visita del viernes');
  });

  it('una llamada VIEJA procesada tarde queda en el historial pero no sustituye al resumen de una posterior (y recibe como anterior lo que había antes de ella)', async () => {
    const p = montar((id) => salidaModelo(id, { resumen: { ...RESUMEN_BUENO, donde_quedo: id === 'netelip:nueva' ? 'Lo de la nueva' : 'Lo de la vieja' } }));
    await evaluarLlamadaCaptacion(p.deps, llamada({ llamadaId: 'nueva', ocurridaEn: new Date('2026-11-18T10:00:00Z') }));
    const vieja = await evaluarLlamadaCaptacion(p.deps, llamada({ llamadaId: 'vieja', ocurridaEn: new Date('2026-11-17T10:00:00Z') }));
    if (vieja.estado !== 'procesada') throw new Error('no procesada');
    expect(p.prompts[1]).toContain('Resumen anterior del lead: ninguno');
    expect(vieja.escrituras.resumen).toContain('Dónde quedó: Lo de la nueva');
    expect(await filas()).toHaveLength(2);
  });

  it('reprocesar la misma llamada no duplica el resumen ni cambia el vigente', async () => {
    const p = montar(salida(RESUMEN_BUENO));
    await evaluarLlamadaCaptacion(p.deps, llamada());
    const otra = await evaluarLlamadaCaptacion(p.deps, llamada());
    if (otra.estado !== 'procesada') throw new Error('no procesada');
    expect(otra.resumen).toEqual({ estado: 'ya_existia' });
    expect(await contar('lead_resumen_historial')).toBe(1);
  });

  it('Escenario «Sin fecha acordada»: «Para qué llamarlo» dice «sin fecha acordada» y la fecha prevista queda vacía', async () => {
    const p = montar(salida({ ...RESUMEN_BUENO, fecha_prevista: null, fecha_prevista_cita: null }));
    const r = await evaluarLlamadaCaptacion(p.deps, llamada());
    if (r.estado !== 'procesada') throw new Error('no procesada');
    expect(r.escrituras.resumen!.split('\n')[3]).toBe('Para qué llamarlo: Confirmar la visita del viernes; sin fecha acordada');
    expect((await filas())[0]?.fecha_prevista).toBeNull();
  });

  it('Escenario «Lead sin presupuesto»: «Para qué llamarlo» incluye «Preguntar presupuesto»', async () => {
    const p = montar(salida(RESUMEN_BUENO, { presupuesto: null }));
    const r = await evaluarLlamadaCaptacion(p.deps, llamada());
    if (r.estado !== 'procesada') throw new Error('no procesada');
    expect(r.escrituras.presupuesto).toBeNull();
    expect(r.escrituras.resumen!.split('\n')[3]).toBe('Para qué llamarlo: Confirmar la visita del viernes; Preguntar presupuesto');
  });

  it('un presupuesto que viene del formulario también cuenta como «presupuesto registrado»: no se pide de nuevo', async () => {
    await registrarPresupuestoFormulario(db, { clickupTaskId: 'lead-ana', opcion: '40.000 – 100.000 €', fechaInteraccion: '2026-11-10T10:00:00.000Z' });
    const p = montar(salida(RESUMEN_BUENO, { presupuesto: null }));
    const r = await evaluarLlamadaCaptacion(p.deps, llamada());
    if (r.estado !== 'procesada') throw new Error('no procesada');
    expect(r.escrituras.presupuesto).toBe(70000);
    expect(r.escrituras.resumen).not.toContain(PREGUNTAR_PRESUPUESTO);
  });

  it('Escenario «Bloque sin información»: «Qué lo frena» indica «Sin información»', async () => {
    const p = montar(salida({ ...RESUMEN_BUENO, que_lo_frena: '' }));
    const r = await evaluarLlamadaCaptacion(p.deps, llamada());
    if (r.estado !== 'procesada') throw new Error('no procesada');
    expect(r.escrituras.resumen!.split('\n')[2]).toBe('Qué lo frena: Sin información');
  });

  it('Escenario «Sin datos de contacto»: un resumen con teléfono o email no se guarda, el anterior se mantiene y la calificación sí se registra', async () => {
    const bueno = montar(salida(RESUMEN_BUENO));
    await evaluarLlamadaCaptacion(bueno.deps, llamada({ llamadaId: '1', ocurridaEn: new Date('2026-11-17T10:00:00Z') }));

    const malo = montar(salida({ ...RESUMEN_BUENO, donde_quedo: 'Dejó su móvil 600 111 222 y ana@example.com' }));
    const r = await evaluarLlamadaCaptacion(malo.deps, llamada({ llamadaId: '2', ocurridaEn: new Date('2026-11-18T10:00:00Z') }));
    if (r.estado !== 'procesada') throw new Error('no procesada');
    expect(r.resumen).toEqual({ estado: 'descartado', motivo: '«Dónde quedó» lleva un dato de contacto' });
    expect(r.descartes).toEqual([{ campo: 'resumen', motivo: '«Dónde quedó» lleva un dato de contacto', cita: null }]);
    expect(r.escrituras.resumen).toContain('Dónde quedó: Vendrá a la oficina el viernes a las seis');
    expect(await filas()).toHaveLength(1);
    // La calificación de esa llamada sí quedó: sus 7 criterios están guardados.
    expect(await contar('lead_criterio_evaluacion')).toBe(14);
    expect(r.escrituras.resumen).not.toContain('600');
  });

  it('un resumen con un importe tampoco se guarda (el presupuesto tiene sus campos)', async () => {
    const p = montar(salida({ ...RESUMEN_BUENO, que_quiere: 'Reforma con presupuesto de 90.000 euros' }));
    const r = await evaluarLlamadaCaptacion(p.deps, llamada());
    if (r.estado !== 'procesada') throw new Error('no procesada');
    expect(r.resumen).toMatchObject({ estado: 'descartado' });
    expect(r.escrituras.resumen).toBeUndefined();
    expect(await contar('lead_resumen_historial')).toBe(0);
    expect(r.categoria).toBe('A+');
  });

  it('un resumen vacío del modelo no escribe nada y no se anota como descarte (la calificación no depende de él)', async () => {
    const p = montar((id) => salidaModelo(id));
    const r = await evaluarLlamadaCaptacion(p.deps, llamada({ transcripcion: TRANSCRIPCION_BASE }));
    if (r.estado !== 'procesada') throw new Error('no procesada');
    expect(r.resumen).toEqual({ estado: 'vacio' });
    expect(r.descartes).toEqual([]);
    expect(r.escrituras.resumen).toBeUndefined();
  });

  it('una fecha prevista con una cita que no está en la llamada invalida el resumen (la fecha nunca se inventa)', async () => {
    const p = montar(salida({ ...RESUMEN_BUENO, fecha_prevista_cita: 'Quedamos el sábado por la mañana en la obra' }));
    const r = await evaluarLlamadaCaptacion(p.deps, llamada());
    if (r.estado !== 'procesada') throw new Error('no procesada');
    expect(r.resumen).toEqual({ estado: 'descartado', motivo: 'la fecha prevista no trae una cita verificable de la llamada' });
  });

  it('Escenario «Fallo de generación»: si la salida del modelo no cumple el contrato, no se guarda nada y el resumen anterior se mantiene', async () => {
    const bueno = montar(salida(RESUMEN_BUENO));
    await evaluarLlamadaCaptacion(bueno.deps, llamada({ llamadaId: '1', ocurridaEn: new Date('2026-11-17T10:00:00Z') }));
    const roto = montar(() => 'esto no es JSON');
    const r = await evaluarLlamadaCaptacion(roto.deps, llamada({ llamadaId: '2', ocurridaEn: new Date('2026-11-18T10:00:00Z') }));
    expect(r).toMatchObject({ estado: 'salida_invalida', clickupTaskId: 'lead-ana' });
    expect(await filas()).toHaveLength(1);
    expect((await cargarResumenVigente(db, 'lead-ana'))?.queQuiere).toBe('Reforma integral de la vivienda');
  });

  it('el resumen de un lead no se mezcla con el de otro', async () => {
    const leads: LeadCandidato[] = [...LEADS, { clickupTaskId: 'lead-bea', esTareaPadre: true, telefono: '+34 611 333 444', email: null }];
    const p = montar((id) => salidaModelo(id, { resumen: { ...RESUMEN_BUENO, que_quiere: id === 'netelip:b' ? 'Cocina de Bea' : 'Piso de Ana' } }));
    p.deps.leads = leads;
    await evaluarLlamadaCaptacion(p.deps, llamada({ llamadaId: 'a' }));
    await evaluarLlamadaCaptacion(p.deps, llamada({ llamadaId: 'b', telefonoE164: '+34611333444' }));
    expect((await cargarResumenVigente(db, 'lead-ana'))?.queQuiere).toBe('Piso de Ana');
    expect((await cargarResumenVigente(db, 'lead-bea'))?.queQuiere).toBe('Cocina de Bea');
    expect(p.prompts[1]).toContain('Resumen anterior del lead: ninguno');
  });
});
