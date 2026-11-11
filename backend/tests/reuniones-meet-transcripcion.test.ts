// Transcripción de Meet → formato del calificador (869fppbcj). Los textos imitan el formato de Meet; no son reuniones reales.
import { describe, expect, it } from 'vitest';
import { citaVerificable } from '../netelip/calificador/reglas.ts';
import { leerTurnos, mismaPersona, prepararTranscripcion, segundos } from '../reuniones-meet/transcripcion.ts';

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
