// Transcripción de Meet → formato del calificador (869fppbcj). Los textos imitan el formato de Meet; no son reuniones reales.
import { describe, expect, it } from 'vitest';
import { citaVerificable } from '../netelip/calificador/reglas.ts';
import { enmascararDirecciones, esCuentaLyn, leerTurnos, mismaPersona, prepararTranscripcion, segundos } from '../reuniones-meet/transcripcion.ts';
import { codigoMeet, duracionAproximada, faseDelTitulo } from '../reuniones-meet/reglas.ts';

const DOC_MEET = `F2 · Visita García - Transcripción
Asistentes: Ernesto Pérez, María García, Luis Gómez
Transcripción
00:00:00

Ernesto Pérez: Buenas tardes, María. Soy Ernesto de Grupo LYN, vengo por la reforma de la cocina.
María García: Hola, pasa. Mira: la cocina es esto que ves.
Ernesto Pérez: Perfecto. ¿Me dejas un teléfono para mandarte el resumen?
00:05:00

María García: Sí, el 612 345 678. Vivimos en calle Mayor 12, segundo
y el portero es Luis.
Ernesto Pérez: Gracias, lo apunto y te escribo esta semana con dos fechas para la presentación.
Fin de la transcripción
La transcripción la ha generado Google Meet.`;

describe('leerTurnos', () => {
  it('documento de Meet: descarta la cabecera, une párrafos partidos y no confunde «Mira:» con una persona', () => {
    const turnos = leerTurnos(DOC_MEET);
    expect(turnos.map((t) => t.hablante)).toEqual(['Ernesto Pérez', 'María García', 'Ernesto Pérez', 'María García', 'Ernesto Pérez']);
    expect(turnos[1].texto).toBe('Hola, pasa. Mira: la cocina es esto que ves.');
    expect(turnos[3]).toMatchObject({ inicio: 300, texto: 'Sí, el 612 345 678. Vivimos en calle Mayor 12, segundo y el portero es Luis.' });
    expect(turnos.some((t) => /Google Meet/.test(t.texto))).toBe(false);
  });

  it('un hablante del equipo cuenta aunque hable una sola vez', () => {
    const turnos = leerTurnos('Ernesto Pérez: Hola.\nCliente Uno: Hola.\nCliente Uno: Adiós.', ['Ernesto Pérez']);
    expect(turnos.map((t) => t.hablante)).toEqual(['Ernesto Pérez', 'Cliente Uno', 'Cliente Uno']);
  });

  it('WEBVTT con voces <v>', () => {
    const vtt = 'WEBVTT\n\n00:00:05.000 --> 00:00:09.000\n<v Ernesto Pérez>Buenas tardes.</v>\n\n00:01:10.500 --> 00:01:15.000\n<v Ana Ruiz>Queremos reformar el baño.';
    expect(leerTurnos(vtt)).toEqual([
      { hablante: 'Ernesto Pérez', inicio: 5, texto: 'Buenas tardes.' },
      { hablante: 'Ana Ruiz', inicio: 70, texto: 'Queremos reformar el baño.' },
    ]);
  });

  it('SRT sin voces: un turno sin hablante por marca de tiempo', () => {
    const srt = '1\n00:00:01,000 --> 00:00:03,000\nHola, buenas.\n\n2\n00:00:04,000 --> 00:00:06,000\nQué tal.';
    expect(leerTurnos(srt)).toEqual([
      { hablante: null, inicio: 1, texto: 'Hola, buenas.' },
      { hablante: null, inicio: 4, texto: 'Qué tal.' },
    ]);
  });

  it('marcas de tiempo', () => {
    expect(segundos('01:02:03')).toBe(3723);
    expect(segundos('02:03')).toBe(123);
    expect(segundos('00:00:05,250')).toBe(5);
  });
});

describe('mismaPersona', () => {
  it('nombre de Meet más largo o más corto que el de empleados, sin tildes ni mayúsculas', () => {
    expect(mismaPersona('Ernesto Pérez López', 'ernesto perez')).toBe(true);
    expect(mismaPersona('Ernesto', 'Ernesto Pérez')).toBe(true);
    expect(mismaPersona('Ernesto Gómez', 'Ernesto Pérez')).toBe(false);
    expect(mismaPersona('', 'Ernesto')).toBe(false);
  });
});

describe('prepararTranscripcion', () => {
  const lista = prepararTranscripcion(DOC_MEET, ['Ernesto Pérez', 'ernesto.perez@grupolyn.com']);

  it('deja el formato de Juan: [hh:mm:ss] GRUPO LYN / CLIENTE, con el minuto de cada turno', () => {
    const lineas = lista.transcripcion.split('\n');
    expect(lineas[0]).toMatch(/^\[00:00:00\] GRUPO LYN: Buenas tardes, \[NOMBRE\]\. Soy Ernesto de Grupo LYN/);
    expect(lineas[3]).toMatch(/^\[00:05:00\] CLIENTE: /);
    expect(lista).toMatchObject({ hablantesLyn: ['Ernesto Pérez'], hablantesCliente: ['María García'], conHablantes: true, duracionSegundos: 300 });
  });

  it('enmascara al cliente, su teléfono y su dirección; el nombre real no llega al modelo', () => {
    expect(lista.transcripcion).not.toMatch(/María|García|612 345 678|calle Mayor/);
    expect(lista.transcripcion).toContain('[TELÉFONO]');
    expect(lista.transcripcion).toContain('[DIRECCIÓN]');
  });

  it('las citas del modelo se pueden verificar con la función de Juan, también cruzando dos turnos', () => {
    expect(citaVerificable('lo apunto y te escribo esta semana con dos fechas', lista.transcripcion)).toBe(true);
    expect(citaVerificable('te mando el presupuesto cerrado mañana', lista.transcripcion)).toBe(false);
  });

  it('Ernesto acompañando al closer nuevo: los dos hablan por GRUPO LYN', () => {
    const p = prepararTranscripcion('Ernesto Pérez: Te presento a Raúl.\nRaúl Sanz: Encantado.\nAna Ruiz: Hola a los dos.\nAna Ruiz: Empezamos.', ['Ernesto Pérez', 'Raúl Sanz']);
    expect(p.transcripcion.split('\n').map((l) => l.replace(/^\[[^\]]*\]\s*/, '').split(':')[0])).toEqual(['GRUPO LYN', 'GRUPO LYN', 'CLIENTE', 'CLIENTE']);
  });

  it('sin hablantes reconocibles: texto enmascarado y conHablantes = false', () => {
    const p = prepararTranscripcion('Hola, llámame al 612345678.', ['Ernesto Pérez']);
    expect(p).toMatchObject({ conHablantes: false, hablantesCliente: [], duracionSegundos: null });
    expect(p.transcripcion).toBe('[00:00:00] Hola, llámame al [TELÉFONO].');
  });
});


// Estructura de una transcripción REAL de Meet en español (11/2026), con frases inventadas: título generado por Meet,
// marcas de tiempo en su línea con líneas en blanco, cuentas de empresa como hablantes y pie con la duración exacta.
const TITULO_REAL = 'Reunión del 9 nov 2026 a las 10:25 GMT-05:00 - Transcripción';
const MEET_REAL = `${TITULO_REAL}
00:00:01

Interiorista Lyn 15: Vamos con el catálogo, ¿vale?
Tech Grupo LYN: Dale.


00:00:09

Interiorista Lyn 15: Lo separo ahí mismo y luego me deja elegir. Entonces,
Tech Grupo LYN: Sí, pero solo si ya lo aprobó el cliente.
Interiorista Lyn 15: Con Marta Ruiz me pasó lo mismo, su teléfono es 612 345 678.


La transcripción finalizó después de 00:11:26

Esta transcripción editable se generó por computadora y puede contener errores. Los usuarios también pueden cambiar el texto después de que se cree.`;

describe('formato real de Meet (11/2026)', () => {
  it('reconoce hablantes con números («Interiorista Lyn 15») y no pierde la primera frase', () => {
    expect(leerTurnos(MEET_REAL).map((t) => [t.hablante, t.inicio, t.texto])).toEqual([
      ['Interiorista Lyn 15', 1, 'Vamos con el catálogo, ¿vale?'],
      ['Tech Grupo LYN', 1, 'Dale.'],
      ['Interiorista Lyn 15', 9, 'Lo separo ahí mismo y luego me deja elegir. Entonces,'],
      ['Tech Grupo LYN', 9, 'Sí, pero solo si ya lo aprobó el cliente.'],
      ['Interiorista Lyn 15', 9, 'Con Marta Ruiz me pasó lo mismo, su teléfono es 612 345 678.'],
    ]);
  });

  it('las cuentas de empresa hablan por GRUPO LYN aunque no sean un empleado; el pie da la duración exacta', () => {
    const p = prepararTranscripcion(MEET_REAL, []);
    expect(p).toMatchObject({ hablantesLyn: ['Interiorista Lyn 15', 'Tech Grupo LYN'], hablantesCliente: [], conHablantes: true, duracionSegundos: 686 });
    expect(p.transcripcion.split(/\r?\n/).every((l) => l.includes('GRUPO LYN:'))).toBe(true);
    expect(p.transcripcion).not.toMatch(/Esta transcripción editable|finalizó/);
  });

  it('un cliente que solo se menciona se enmascara si se conoce su nombre (invitado de Calendar o lead)', () => {
    expect(prepararTranscripcion(MEET_REAL, []).transcripcion).toContain('Marta Ruiz');   // sin saberlo, no hay cómo
    const p = prepararTranscripcion(MEET_REAL, [], { nombresCliente: ['Marta Ruiz'] });
    expect(p.transcripcion).not.toMatch(/Marta|Ruiz|612 345 678/);
    expect(p.transcripcion).toContain('[NOMBRE]');
  });

  it('el título que genera Meet no trae fase ni código: hace falta que el evento lleve la fase', () => {
    expect(faseDelTitulo(TITULO_REAL)).toBeNull();
    expect(codigoMeet(TITULO_REAL, MEET_REAL)).toBeNull();
    expect(duracionAproximada(MEET_REAL)).toBe(686);
  });

  it('esCuentaLyn: solo con la palabra LYN o GrupoLyn', () => {
    expect(esCuentaLyn('Tech Grupo LYN')).toBe(true);
    expect(esCuentaLyn('Interiorista Lyn 15')).toBe(true);
    expect(esCuentaLyn('GrupoLyn Admin')).toBe(true);
    expect(esCuentaLyn('Carolyn Smith')).toBe(false);
    expect(esCuentaLyn('María García')).toBe(false);
  });
});

describe('direcciones en mitad de una frase', () => {
  it('se tapan aunque sigan más palabras; sin número no se toca (no es una dirección completa)', () => {
    expect(enmascararDirecciones('Vivimos en la calle Mayor 12, por si lo necesitáis.')).toBe('Vivimos en la [DIRECCIÓN], por si lo necesitáis.');
    expect(enmascararDirecciones('Es en Avenida de la Estación 45 3º B y luego vemos.')).toBe('Es en [DIRECCIÓN] y luego vemos.');
    expect(enmascararDirecciones('En c/ San Vicente 7, segundo.')).toBe('En [DIRECCIÓN], segundo.');
    expect(enmascararDirecciones('Paseo Marítimo nº 3 al lado del mar.')).toBe('[DIRECCIÓN] al lado del mar.');
    expect(enmascararDirecciones('La calle es estrecha y el camino largo.')).toBe('La calle es estrecha y el camino largo.');
    expect(enmascararDirecciones('Quedamos en la plaza a las 10.')).toBe('Quedamos en la plaza a las 10.');
  });
  it('prepararTranscripcion ya lo aplica', () => {
    const p = prepararTranscripcion('Ana Gil: Vivimos en la calle Mayor 12, por si lo necesitáis.\nAna Gil: Gracias.', []);
    expect(p.transcripcion).not.toMatch(/Mayor/);
  });
});
