import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { loadProtocolWeeklySnapshot, parseWeeklyWindow } from '../protocol-weekly.ts';

describe('weekly protocol snapshot', () => {
  it('rejects invalid or oversized periods', () => {
    const now = Date.parse('2026-11-16T13:00:00Z');
    expect(parseWeeklyWindow('2026-11-09T05:00:00.000Z', '2026-11-16T05:00:00.000Z', now)).toBeTruthy();
    expect(() => parseWeeklyWindow('2026-11-09', '2026-11-16', now)).toThrow();
    expect(() => parseWeeklyWindow('2026-11-01T05:00:00.000Z', '2026-11-16T05:00:00.000Z', now)).toThrow();
  });

  it('includes unanswered and rejected consultations but not answered questions in the CSV payload', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      { id: '1', creada_en: new Date('2026-11-10T12:00:00Z'), rol: 'PMC', estado: 'respondida', pregunta_original: 'Resuelta', pregunta_reformulada: 'Resuelta', tema: 'materiales', corpus_version: 'v1', cita_invalida: false, tokens_entrada: 2, tokens_salida: 3 },
      { id: '2', creada_en: new Date('2026-11-11T12:00:00Z'), rol: 'PMC', estado: 'sin_respuesta', pregunta_original: 'Sin protocolo', pregunta_reformulada: 'Sin protocolo', tema: 'materiales', corpus_version: 'v1', cita_invalida: true, tokens_entrada: null, tokens_salida: null },
    ] });
    const result = await loadProtocolWeeklySnapshot({ query } as unknown as Pool, '2026-11-09T05:00:00.000Z', '2026-11-16T05:00:00.000Z');
    expect(result.preguntas).toHaveLength(1);
    expect(result.preguntas[0]).toMatchObject({ pregunta_original: 'Sin protocolo', cita_invalida: true });
    expect(result.metricas).toEqual([{ estado: 'respondida', total: 1, entrada: 2, cache: 0, salida: 3 }, { estado: 'sin_respuesta', total: 1, entrada: 0, cache: 0, salida: 0 }]);
    expect(query.mock.calls[0][0]).toContain("clasificacion <> 'aclaracion'");
  });
});
