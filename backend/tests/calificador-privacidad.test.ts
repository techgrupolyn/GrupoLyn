// Calificador (869e9y98n), hallazgos de QA del 11/11: direcciones sin enmascarar (CAL-01) y duda que no escala (CAL-04).
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { decidir, detectarRespuestaAmbigua, enmascarar, type SalidaModelo } from '../netelip/calificador/reglas.ts';
import { procesarSiguienteEvaluacion, type ConfigCalificador } from '../netelip/calificador/proceso.ts';
import { promptSistema, promptSistemaVersionado } from '../netelip/calificador/modelo.ts';
import { RUBRICA_SDR_V1 } from '../netelip/calificador/rubrica.ts';
import { addressVariants, containsUnmaskedPersonalData, maskProtocolQuestion } from '../protocol-privacy.ts';

describe('CAL-01 · direcciones enmascaradas antes del modelo', () => {
  it('la frase de QA viaja con [DIRECCIÓN]', () => {
    const masked = enmascarar('[00:01:10] CLIENTE: Soy Lucía Fernández y vive en Calle Mayor 23, 3ºB, Alicante, por si queréis pasar.', ['Lucía Fernández']);
    expect(masked).toBe('[00:01:10] CLIENTE: Soy [NOMBRE] y vive en [DIRECCIÓN], Alicante, por si queréis pasar.');
  });

  it.each([
    ['Es en Avda. de la Estación 45, 2º izq., 03005 Alicante.', 'Es en [DIRECCIÓN] Alicante.'],
    ['Apunta: C/ San Vicente 7, segundo, gracias.', 'Apunta: [DIRECCIÓN], gracias.'],
    ['c/ mayor 12 bajo B', '[DIRECCIÓN]'],
    ['En la Plaza de España nº 3 al lado del bar.', 'En la [DIRECCIÓN] al lado del bar.'],
    ['Plaza de los Luceros 4', '[DIRECCIÓN]'],
    ['calle mayor número 23, tercero', '[DIRECCIÓN]'],
    ['la calle mayor 23, 3ºB y ya', 'la [DIRECCIÓN] y ya'],
    ['Carretera de Ocaña km 4, Elche', '[DIRECCIÓN], Elche'],
    ['Partida Les Fonts 12, polígono 5, parcela 23', '[DIRECCIÓN], [DIRECCIÓN]'],
    ['Urbanización Los Pinos, 14, CP 03560', '[DIRECCIÓN]'],
    ['el código postal es 03690', 'el código postal es [DIRECCIÓN]'],
  ])('%s', (texto, esperado) => {
    expect(maskProtocolQuestion(texto)).toBe(esperado);
    expect(containsUnmaskedPersonalData(texto)).toBe(true);
    expect(containsUnmaskedPersonalData(esperado)).toBe(false);
  });

  it.each([
    'La calle está cortada por obras.',
    'Es un piso de 90 metros en planta baja.',
    'Quedamos en la plaza a las 10.',
    'la calle tiene 3 carriles',
    'Vivo en la calle Mayor, cerca del mercado.',
    'La Plaza de Castilla tiene 3 salidas',
    'El presupuesto ronda los 25000 euros y la obra dura 12 semanas.',
    '[00:01:10] GRUPO LYN: una vivienda de 90 m² puede moverse entre 60.000 y 90.000 euros',
  ])('no toca «%s»', (texto) => {
    expect(maskProtocolQuestion(texto)).toBe(texto);
    expect(containsUnmaskedPersonalData(texto)).toBe(false);
  });

  it('la dirección guardada en el CRM se tapa aunque se diga de otra forma', () => {
    expect(addressVariants('C/ San Vicente Mártir 23, 3ºB')).toEqual(['C/ San Vicente Mártir 23, 3ºB', 'San Vicente Mártir 23', 'San Vicente Mártir']);
    const direcciones = ['C/ San Vicente Mártir 23, 3ºB'];
    expect(enmascarar('Vale, en san vicente mártir, número 23, ¿no?', [], direcciones)).toBe('Vale, en [DIRECCIÓN], ¿no?');
    expect(enmascarar('La obra de San Vicente Mártir está parada', [], direcciones)).toBe('La obra de [DIRECCIÓN] está parada');
    // Una sola palabra común del nombre de la vía no se tapa sola.
    expect(enmascarar('El mayor problema es la cocina', [], ['Calle Mayor 23'])).toBe('El mayor problema es la cocina');
  });

  it('el proceso pide las direcciones de las obras del cliente y las enmascara', async () => {
    const queries: string[] = [];
    let user = '';
    const job = { id: '7', llamada_id: '42', intentos: 1, rol: 'sdr', extension_netelip: '120', direction: 'outbound', duration_seconds: 240,
      occurred_at: new Date('2026-11-09T09:32:00Z'), t_status: 'completed', t_text: '', lead_name: '', client_name: '',
      client_addresses: ['Avenida Maisonnave 12, 4ºA'],
      segments: [{ speaker: 'cliente', start: 3, end: 8, text: 'La obra es en Maisonnave 12, el cuarto.' }] };
    const client = { query: async () => ({ rows: [], rowCount: 1 }), release: () => undefined };
    const pool = {
      query: async (sql: string) => { queries.push(sql); return /SET estado = 'procesando'/.test(sql) ? { rows: [job], rowCount: 1 } : { rows: [], rowCount: 1 }; },
      connect: async () => client,
    } as unknown as Pool;
    const config: ConfigCalificador = { supervisorNombre: 'Ernesto', supervisorWhatsapp: null, dashboardUrl: null, envioActivo: false };
    await procesarSiguienteEvaluacion(pool, async (_s, u) => { user = u; return { text: 'no json', model: 'm', inputTokens: null, outputTokens: null }; }, config);
    expect(queries[0]).toMatch(/SELECT p\.direccion FROM proyectos p WHERE p\.cliente_id = COALESCE\(c\.client_id, l\.client_id\)/);
    expect(user).toContain('La obra es en [DIRECCIÓN], el cuarto.');
  });
});

const salida = (over: Partial<SalidaModelo> = {}): SalidaModelo => ({
  llamada_evaluable: true, motivo_no_evaluable: null, nota: 82, errores_criticos: [],
  bien: ['Apertura clara', 'Horquilla bien explicada'], mejorar: [{ que: 'a', accion: 'b' }, { que: 'c', accion: 'd' }],
  duda: { valor: false, motivo: null }, objeciones: [], ...over,
});
const ctx = { presupuestoRegistrado: false, supervisor: 'Ernesto' };
const AMBIGUA = [
  '[00:01:30] CLIENTE: El muro entre la cocina y el salón, ¿se puede tirar?',
  '[00:01:45] GRUPO LYN: En principio no debería haber mucho problema, aunque depende de varias cosas, ya lo veríamos.',
].join('\n');

describe('CAL-04 · la respuesta ambigua sobre viabilidad escala por duda', () => {
  it('el prompt fijo y el versionado piden duda ante respuestas ambiguas', () => {
    for (const prompt of [promptSistema(), promptSistemaVersionado(RUBRICA_SDR_V1)]) {
      expect(prompt).toContain('## Respuestas ambiguas sobre viabilidad, plazo o precio');
      expect(prompt).toContain('«no debería haber (mucho) problema»');
    }
  });

  it('detecta la frase del comercial de QA y otras fórmulas ambiguas', () => {
    expect(detectarRespuestaAmbigua(AMBIGUA)).toBe('En principio no debería haber mucho problema, aunque depende de varias cosas, ya lo veríamos.');
    expect(detectarRespuestaAmbigua('[00:01:00] CLIENTE: ¿Estaría terminada antes de Navidad?\n[00:01:10] GRUPO LYN: En principio sí, seguramente se pueda.')).not.toBeNull();
  });

  it('no salta con «depende» al dar la horquilla, con la respuesta correcta ni con el cliente', () => {
    expect(detectarRespuestaAmbigua('[00:02:40] GRUPO LYN: Depende de baños y calidades: entre 60.000 y 90.000 euros, orientativo.')).toBeNull();
    expect(detectarRespuestaAmbigua('[00:01:30] CLIENTE: ¿Se puede tirar el muro?\n[00:01:45] GRUPO LYN: Eso lo revisa nuestro técnico y te respondo el viernes.')).toBeNull();
    expect(detectarRespuestaAmbigua('[00:03:30] GRUPO LYN: ¿Os viene bien el jueves a las cinco?\n[00:03:40] CLIENTE: En principio sí, no debería haber problema.')).toBeNull();
    // Sin tema técnico, de plazo o de precio cerca, «ya lo veremos» no es duda.
    expect(detectarRespuestaAmbigua('[00:00:20] GRUPO LYN: Si te pillo mal, ya lo veremos otro día.')).toBeNull();
  });

  it('si el modelo no marca la duda, el código la fuerza y escala (nota 82, sin error crítico)', () => {
    const d = decidir(salida(), AMBIGUA, ctx);
    expect(d.duda).toBe(true);
    expect(d.apto).toBe(true);
    expect(d.escalado).toBe(true);
    expect(d.motivo_escalado).toBe('duda: respuesta ambigua sobre viabilidad, plazo o precio: «En principio no debería haber mucho problema, aunque depende de varias cosas, ya lo veríamos.»');
  });

  it('se respeta el motivo del modelo y no se duplica con un LÍMITE PROFESIONAL válido', () => {
    expect(decidir(salida({ duda: { valor: true, motivo: 'respuesta ambigua sobre el muro' } }), AMBIGUA, ctx).motivo_duda).toBe('respuesta ambigua sobre el muro');
    const limite = decidir(salida({ errores_criticos: [{ regla: 'LIMITE_PROFESIONAL', cita: 'En principio no debería haber mucho problema', marca_tiempo: '00:01:45' }] }), AMBIGUA, ctx);
    expect(limite.duda).toBe(false);
    expect(limite.motivo_escalado).toBe('error crítico: LÍMITE PROFESIONAL');
  });
});
