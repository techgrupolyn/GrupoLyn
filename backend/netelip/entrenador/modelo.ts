// Prompt del documento del entrenador: con lo que el calificador sacó de las llamadas del periodo,
// Gemini propone añadidos al «Contexto unificado». No reescribe el documento: solo propone entradas.
import { NOMBRE_REGLA, type ReglaCritica } from '../calificador/reglas.ts';
import { ARQUETIPOS, MAX_ARQUETIPOS, MAX_FRASES, MAX_OBJECIONES } from './documento.ts';

export const SCHEMA_PROPUESTA = {
  type: 'object',
  properties: {
    resumen: { type: 'string' },
    objeciones: { type: 'array', maxItems: MAX_OBJECIONES, items: { type: 'object', properties: {
      objecion: { type: 'string' }, criterio: { type: 'string' }, cita: { type: ['string', 'null'] },
    }, required: ['objecion', 'criterio', 'cita'] } },
    arquetipos: { type: 'array', maxItems: MAX_ARQUETIPOS, items: { type: 'object', properties: {
      arquetipo: { type: 'string', enum: [...ARQUETIPOS] }, material: { type: 'string' },
    }, required: ['arquetipo', 'material'] } },
    frases: { type: 'array', maxItems: MAX_FRASES, items: { type: 'object', properties: {
      situacion: { type: 'string' }, frase: { type: 'string' },
    }, required: ['situacion', 'frase'] } },
  },
  required: ['resumen', 'objeciones', 'arquetipos', 'frases'],
};

export const PROMPT_SISTEMA = `Mantienes el documento «Contexto unificado del Entrenador de llamadas Fase 0» de Grupo LYN. Los comerciales lo cargan en ChatGPT para simular llamadas con clientes y practicar.

Recibes el documento actual y lo que el calificador interno extrajo de llamadas REALES de Netelip en un periodo: objeciones del cliente con su cita literal, errores críticos del comercial y mejoras. Propón SOLO lo que haga más realista y útil la simulación:

1. objeciones: objeciones reales que NO estén ya en la sección 11 (Banco de objeciones), o que lleguen formuladas de una forma claramente distinta. Para cada una: la objeción como la diría un cliente (corta), el criterio correcto según las reglas de ESTE documento (sin inventar políticas, precios, plazos ni procesos de Grupo LYN) y la cita real copiada literalmente de los datos, o null.
2. arquetipos: material real (frases o situaciones típicas) que dé realismo al cliente de un arquetipo A-G de la sección 6.
3. frases: frases de referencia nuevas para corregir al comercial (sección 18), solo si un error se repite en el periodo y la sección no tiene ya una frase para esa situación.

Reglas:
- Español de España. Breve y concreto: cada entrada en 1-3 frases.
- No repitas lo que el documento ya dice, aunque sea con otras palabras. Si no hay nada nuevo, devuelve listas vacías.
- Nunca contradigas el Manual Fase 0 del documento: si una cita real muestra un error del comercial, el criterio es el correcto, no lo que hizo el comercial.
- Los datos personales vienen sustituidos por marcadores ([NOMBRE], [TELÉFONO], [DIRECCIÓN]…). No los reconstruyas ni añadas datos que identifiquen a nadie (nombres, calles, empresas).
- resumen: 1-3 frases para el supervisor con qué aportan estas llamadas al documento.`;

export type LlamadaPeriodo = {
  id: string; rol: string; direccion: string; duracion: number; nota: number | null; apto: boolean | null;
  errores: Array<{ regla: string; cita: string }>; mejorar: Array<{ que: string; accion: string }>;
  objeciones: Array<{ tipo: string; cita: string; idea_contenido: string | null }>;
};

export function promptUsuario(documento: string, llamadas: LlamadaPeriodo[]): string {
  const casos = llamadas.map((l, i) => {
    const min = Math.max(1, Math.round(l.duracion / 60));
    return [
      `Llamada ${i + 1} · ${l.rol} · ${l.direccion === 'outbound' ? 'saliente' : 'entrante'} · ${min} min · nota ${l.nota ?? '—'} · ${l.apto ? 'APTO' : 'NO APTO'}`,
      ...l.errores.map((e) => `Error crítico (${NOMBRE_REGLA[e.regla as ReglaCritica] || e.regla}): «${e.cita}»`),
      ...l.mejorar.map((m) => `Mejorar: ${m.que} → ${m.accion}`),
      ...l.objeciones.map((o) => `Objeción (${o.tipo}): «${o.cita}»${o.idea_contenido ? ` · idea de contenido: ${o.idea_contenido}` : ''}`),
    ].join('\n');
  }).join('\n\n');
  return `DOCUMENTO ACTUAL:\n<<<\n${documento}\n>>>\n\nLLAMADAS REALES DEL PERIODO (${llamadas.length}):\n\n${casos}`;
}

/** Citas del periodo: solo estas pueden aparecer como «Dicho por un cliente real». */
export const citasDelPeriodo = (llamadas: LlamadaPeriodo[]) => llamadas.flatMap((l) => [...l.objeciones.map((o) => o.cita), ...l.errores.map((e) => e.cita)]);
