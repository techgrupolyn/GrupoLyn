import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { loadProtocolReport, parseProtocolReportFilters } from '../protocol-report.ts';
import { canReadProtocolLog, canReadProtocolReport } from '../protocol-privacy.ts';

describe('reporte de consultas de protocolos', () => {
  it('permite el agregado al Gerente técnico sin abrir el historial', () => {
    expect(canReadProtocolReport('employee:gerente_tecnico')).toBe(true);
    expect(canReadProtocolLog('employee:gerente_tecnico')).toBe(false);
    expect(canReadProtocolReport('employee:director')).toBe(true);
    expect(canReadProtocolReport('superadmin')).toBe(true);
    expect(canReadProtocolReport('employee:interiorista')).toBe(false);
    expect(canReadProtocolReport('admin')).toBe(true);
  });

  it('usa siete días y umbral tres por defecto', () => {
    expect(parseProtocolReportFilters({}, new Date('2026-10-28T12:00:00Z'))).toEqual({
      from: '2026-10-22', to: '2026-10-28', area: null, role: null, minCount: 3,
    });
  });

  it('rechaza filtros inválidos y acepta periodos explícitos', () => {
    expect(parseProtocolReportFilters({ from: '2026-10-01', to: '2026-10-28', area: 'obra', role: 'PMC', minCount: '2' }).minCount).toBe(2);
    expect(() => parseProtocolReportFilters({ from: '2026-10-30', to: '2026-10-28' })).toThrow('Periodo inválido');
    expect(() => parseProtocolReportFilters({ area: 'otro;DROP TABLE' })).toThrow('Área inválida');
    expect(() => parseProtocolReportFilters({ minCount: '0' })).toThrow('Umbral inválido');
  });

  it('parametriza filtros y separa popularidad de motivos sin respuesta', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ tema: 'revisión semanal', consultas: 4 }] })
      .mockResolvedValueOnce({ rows: [{ tema: 'duda técnica', consultas: 2 }] })
      .mockResolvedValueOnce({ rows: [{ total: 6 }] });
    const filters = parseProtocolReportFilters({ from: '2026-10-22', to: '2026-10-28', area: 'obra', role: 'PMC', minCount: '3' });
    expect(await loadProtocolReport({ query } as unknown as Pool, filters)).toEqual({
      popular: [{ tema: 'revisión semanal', consultas: 4 }], unanswered: [{ tema: 'duda técnica', consultas: 2 }], total: 6,
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0][1]).toEqual(['2026-10-22T00:00:00Z', '2026-10-29T00:00:00.000Z', 'obra', 'PMC', 3]);
    expect(query.mock.calls[0][0]).toContain("clasificacion <> 'aclaracion'");
    expect(query.mock.calls[0][0]).toContain('HAVING COUNT(*) >= $5');
    expect(query.mock.calls[1][0]).toContain("motivo_no_respuesta IN ('sin_protocolo', 'fuera_de_alcance', 'tema_sensible')");
    expect(query.mock.calls[1][0]).toContain('resuelta_por_usuario IS FALSE');
    expect(query.mock.calls[1][0]).not.toContain('HAVING COUNT(*) >= $5');
    expect(query.mock.calls[1][1]).toEqual(['2026-10-22T00:00:00Z', '2026-10-29T00:00:00.000Z', 'obra', 'PMC']);
  });
});
