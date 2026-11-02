import { describe, expect, it } from 'vitest';
import { createProtocolCorpus } from '../protocol-corpus.ts';
import { askProtocolAgent, type ProtocolLog } from '../protocol-agent.ts';
import { findProjectAssignment, projectAssignmentsSheetId } from '../protocol-assignments.ts';

const sheet = {
  id: projectAssignmentsSheetId,
  name: 'Reparto de obras',
  mimeType: 'application/vnd.google-apps.spreadsheet',
  modifiedTime: '2026-11-02T00:00:00Z',
  revision: '3',
  warnings: [],
  sections: [
    { ref: 'PM DELINEANTE!I17', text: 'Obra: Torre del cura; PMC: Andreina; Delineante: Giuliana' },
    { ref: 'INTERIORISTAS!M6', text: 'Obra: Torre del cura; Interiorista: Joaquín' },
    { ref: 'PM DELINEANTE!I13', text: 'Obra: Catral; PMC: Andreina; Delineante: Ivana - dib; Situación: Obra con incidencias importantes o entrega intensa o villa o remates volumen alto' },
    { ref: 'INTERIORISTAS!M8', text: 'Obra: Catral; Interiorista: Joaquín' },
    { ref: 'PM DELINEANTE!B11', text: 'Obra: Mar jonica; PMC: Lunilse; Delineante: Laura; Situación: Obra remates volumen bajo' },
    { ref: 'INTERIORISTAS!A5', text: 'Obra: Mar jonica; Interiorista: Amanda' },
    { ref: 'PM DELINEANTE!R12', text: 'Obra: Maite; Estado: Final octubre' },
    { ref: 'INTERIORISTAS!G5', text: 'Obra: Maite; Interiorista: Mari Carmen' },
  ],
};

describe('consulta de responsables por obra', () => {
  it('responde a obra y estado con evidencia de la hoja', () => {
    const answer = findProjectAssignment('¿Quién lleva la obra Torre del Cura y cuál es su estado?', sheet);
    expect(answer?.answer).toContain('PMC: Andreina');
    expect(answer?.answer).toContain('Delineante: Giuliana');
    expect(answer?.answer).toContain('Interiorista: Joaquín');
    expect(answer?.answer).toContain('La situación no consta');
    expect(answer?.complete).toBe(false);
    expect(answer?.sections).toHaveLength(2);
  });

  it('no inventa estado ni acepta una obra no identificada', () => {
    expect(findProjectAssignment('¿Cómo va Catral?', sheet)?.answer).toContain('Obra con incidencias importantes');
    expect(findProjectAssignment('¿En qué estado figura Maite?', sheet)?.answer).toContain('Estado: Final octubre');
    expect(findProjectAssignment('¿Quién lleva la obra desconocida?', sheet)).toBeNull();
  });

  it('no declara resuelta una consulta si falta alguno de los cargos solicitados', () => {
    const onlyPmc = { ...sheet, sections: [{ ref: 'PM DELINEANTE!I17', text: 'Obra: Torre del cura; PMC: Andreina' }] };
    const answer = findProjectAssignment('¿Quiénes son el PMC y el delineante de Torre del Cura?', onlyPmc);
    expect(answer?.answer).toContain('Delineante: no consta en la hoja');
    expect(answer?.complete).toBe(false);
  });

  it('resuelve localmente sin enviar la hoja ni nombres al modelo', async () => {
    const logs: ProtocolLog[] = [];
    const generate = async () => { throw new Error('No debe llamar al modelo'); };
    const result = await askProtocolAgent({ userId: 1, role: 'PMC', question: '¿Quién está a cargo de Torre del cura?', channel: 'superagente' }, {
      loadCorpus: async () => createProtocolCorpus([sheet], 1000),
      clientNames: async () => [],
      roles: async () => [{ name: 'PMC' }],
      generate,
      save: async log => { logs.push(log); },
    });
    expect(result.answer).toContain('PMC: Andreina');
    expect(result.sources.map(source => source.seccion)).toEqual(['PM DELINEANTE!I17', 'INTERIORISTAS!M6']);
    expect(logs[0].model).toBeNull();
  });

  it('no envía la hoja al modelo para una pregunta de protocolos', async () => {
    const calls: string[] = [];
    await askProtocolAgent({ userId: 1, role: 'PMC', question: '¿Quién revisa el presupuesto?', channel: 'superagente' }, {
      loadCorpus: async () => createProtocolCorpus([sheet, {
        id: 'manual', name: 'Control de presupuestos', mimeType: 'application/pdf', modifiedTime: '2026-10-25T00:00:00Z', revision: '1', warnings: [],
        sections: [{ ref: 'página 1', text: 'El PMC revisa el presupuesto antes de subirlo a Club LYN.' }],
      }], 1000),
      clientNames: async () => [],
      roles: async () => [{ name: 'PMC' }],
      generate: async (system) => { calls.push(system); return { model: 'test', text: JSON.stringify({ clasificacion: 'resuelta', respuesta: 'El PMC revisa el presupuesto antes de subirlo a Club LYN.', fuentes: [{ doc_id: 'manual', seccion: 'página 1', cita: 'El PMC revisa el presupuesto antes de subirlo' }], motivo_no_respuesta: null, cargo_derivacion: null, contradiccion: null, area: 'presupuestos', tema: 'revisión del presupuesto' }) }; },
      save: async () => undefined,
    });
    expect(calls[0]).toContain('El PMC revisa el presupuesto');
    expect(calls[0]).not.toContain('Torre del cura');
    expect(calls[0]).not.toContain('Andreina');
  });
});
