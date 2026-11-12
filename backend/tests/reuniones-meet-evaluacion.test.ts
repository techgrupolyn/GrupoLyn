// Piezas sueltas de la evaluación de reuniones (869fppbcj). Sin base de datos ni Gemini.
import { describe, expect, it } from 'vitest';
import { conDudaSinHablantes, configReunionesDesdeEnv, promptUsuarioReunion } from '../reuniones-meet/evaluacion.ts';
import { horarioDelEvento } from '../reuniones-meet/invitados.ts';
import { FASE_DE_ROL } from '../reuniones-meet/reevaluar.ts';
import { ROL_DE_FASE } from '../reuniones-meet/proceso.ts';

const decision = { errores_criticos: [], errores_descartados: [], apto: true, escalado: false, motivo_escalado: null, duda: false, motivo_duda: null, objeciones: [] };

describe('horarioDelEvento', () => {
  it('inicio, fin y duración de un evento con hora', () => {
    expect(horarioDelEvento({ start: { dateTime: '2026-11-10T10:00:00+01:00' }, end: { dateTime: '2026-11-10T10:55:00+01:00' } }))
      .toEqual({ inicio: '2026-11-10T09:00:00.000Z', fin: '2026-11-10T09:55:00.000Z', duracion_segundos: 3300 });
  });
  it('un evento de día entero o con fechas raras no da hora ni duración', () => {
    expect(horarioDelEvento({ start: { date: '2026-11-10' }, end: { date: '2026-11-11' } })).toEqual({ inicio: null, fin: null, duracion_segundos: null });
    expect(horarioDelEvento({ start: { dateTime: '2026-11-10T10:00:00Z' }, end: { dateTime: '2026-11-11T10:00:00Z' } }).duracion_segundos).toBeNull();   // 24 h
  });
});

describe('prompt y decisión de una reunión', () => {
  it('el contexto no lleva datos del cliente y avisa si no hay hablantes', () => {
    expect(promptUsuarioReunion({ rol: 'closer_f2', fase: 'F2', duracionSegundos: 3300, conHablantes: true, transcripcion: '[00:00:00] GRUPO LYN: Hola.' }))
      .toBe('Contexto: rol closer_f2 · reunión de Meet de F2 · 55 min · presupuesto_registrado: no\n\nTranscripción:\n[00:00:00] GRUPO LYN: Hola.');
    expect(promptUsuarioReunion({ rol: null, fase: null, duracionSegundos: null, conHablantes: false, transcripcion: 'x' }))
      .toContain('rol closer · reunión de Meet · duración desconocida · hablantes sin identificar');
  });
  it('sin hablantes: con duda y escalada; si ya tenía duda, no se toca', () => {
    expect(conDudaSinHablantes(decision)).toMatchObject({ duda: true, escalado: true, motivo_escalado: expect.stringContaining('no identificó a los hablantes') });
    const ya = { ...decision, duda: true, motivo_duda: 'otra', escalado: true, motivo_escalado: 'duda: otra' };
    expect(conDudaSinHablantes(ya)).toBe(ya);
  });
  it('fase y rol de rúbrica van en los dos sentidos', () => {
    for (const [fase, rol] of Object.entries(ROL_DE_FASE)) expect(FASE_DE_ROL[rol]).toBe(fase);
    expect(FASE_DE_ROL.sdr).toBeUndefined();
  });
  it('configuración: máximo de caracteres por defecto y sin valores absurdos', () => {
    expect(configReunionesDesdeEnv({}).maxCaracteres).toBe(150_000);
    expect(configReunionesDesdeEnv({ REUNIONES_MEET_MAX_CARACTERES: '50' }).maxCaracteres).toBe(150_000);
    expect(configReunionesDesdeEnv({ REUNIONES_MEET_MAX_CARACTERES: '90000', CALIFICADOR_SUPERVISOR_NOMBRE: 'Alex' })).toEqual({ maxCaracteres: 90_000, supervisorNombre: 'Alex' });
  });
});
