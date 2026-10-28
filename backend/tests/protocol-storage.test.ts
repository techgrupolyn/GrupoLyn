import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { ProtocolLog } from '../protocol-agent.ts';
import { PROTOCOL_QUERY_PAGE_SIZE, countProtocolQueries, listProtocolQueries, loadProtocolVisionCache, pruneProtocolQueries, saveProtocolQuery, saveProtocolVisionCache } from '../protocol-storage.ts';

describe('registro de protocolos', () => {
  it('pagina de diez en diez y devuelve el total del historial', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 'consulta-11' }] }).mockResolvedValueOnce({ rows: [{ total: '23' }] });
    const pool = { query } as unknown as Pool;
    expect(PROTOCOL_QUERY_PAGE_SIZE).toBe(10);
    expect(await listProtocolQueries(pool, 10)).toEqual([{ id: 'consulta-11' }]);
    expect(query.mock.calls[0][1]).toEqual([10, 10]);
    expect(await countProtocolQueries(pool)).toBe(23);
  });

  it('conserva las consultas durante doce meses', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 3 });
    expect(await pruneProtocolQueries({ query } as unknown as Pool)).toBe(3);
    expect(query.mock.calls[0][0]).toContain("creado_en < NOW() - INTERVAL '12 months'");
  });

  it('guarda consumo y versión del corpus junto a la consulta enmascarada', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const log: ProtocolLog = {
      id: '00000000-0000-0000-0000-000000000001', userId: 1, role: 'PMC', question: '[NOMBRE] pregunta', answer: 'Respuesta',
      classification: 'resuelta', reason: null, area: 'diseno', topic: 'revision semanal', sources: [], derivationRole: null,
      contradiction: null, validation: 'ok', corpusVersionId: 'a'.repeat(64), model: 'flash', inputTokens: 120,
      outputTokens: 34, latencyMs: 1000, error: null,
    };
    await saveProtocolQuery({ query } as unknown as Pool, log);
    expect(query.mock.calls[0][1]).toHaveLength(19);
    expect(query.mock.calls[0][1]).toContain(log.corpusVersionId);
    expect(query.mock.calls[0][1]).toContain(120);
    expect(query.mock.calls[0][1]).toContain(34);
    expect(query.mock.calls[0][1]).not.toContain('Nombre real');
  });

  it('reutiliza una transcripción solo si coinciden archivo, revisión, página e imagen', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ markdown: '| Fase | PMC |' }] }).mockResolvedValue({ rowCount: 1 });
    const pool = { query } as unknown as Pool;
    const value = await loadProtocolVisionCache(pool, 'doc', 'rev-1', 'página 2', 'a'.repeat(64));
    expect(value).toBe('| Fase | PMC |');
    expect(query.mock.calls[0][1]).toEqual(['doc', 'rev-1', 'página 2', 'a'.repeat(64)]);
    await saveProtocolVisionCache(pool, 'doc', 'rev-1', 'página 2', 'a'.repeat(64), value!);
    expect(query.mock.calls[1][1]).toEqual(['doc', 'rev-1', 'página 2', 'a'.repeat(64), value]);
  });
});
