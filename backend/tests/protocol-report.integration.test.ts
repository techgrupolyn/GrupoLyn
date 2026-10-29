import { describe, expect, it } from 'vitest';
import pg, { type Pool } from 'pg';
import { loadProtocolReport, parseProtocolReportFilters } from '../protocol-report.ts';

const databaseUrl = process.env.PROTOCOL_REPORT_TEST_DATABASE_URL;
const localDatabase = databaseUrl && ['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname);

describe.skipIf(!localDatabase)('reporte SQL con 40 consultas ficticias', () => {
  it('agrupa, filtra y excluye aclaraciones sin exponer identidades', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE agente_protocolos_consultas (
        id uuid, creado_en timestamptz, usuario_id integer, cargo text, pregunta text,
        clasificacion text, motivo_no_respuesta text, area text, tema text,
        fuentes jsonb, validacion text, resuelta_por_usuario boolean
      ) ON COMMIT DROP`);

      const themes = [
        ['revisión semanal pmc', 5], ['plazo de pedido de material', 2],
        ['protocolo ausente', 7], ['recepción de obra', 6],
        ['presupuesto', 6], ['escalado', 5], ['documentos', 5], ['seguimiento', 4],
      ] as const;
      let sequence = 0;
      for (const [theme, count] of themes) {
        for (let index = 0; index < count; index += 1) {
          sequence += 1;
          const reason = theme === 'protocolo ausente' && index === 0 ? 'sin_protocolo'
            : theme === 'recepción de obra' && index === 0 ? 'sin_protocolo' : null;
          const validation = theme === 'protocolo ausente' && index === 1 ? 'rechazada' : 'ok';
          const solved = !(theme === 'protocolo ausente' && index === 2);
          const classification = theme === 'seguimiento' && index === 0 ? 'aclaracion' : 'resuelta';
          const createdAt = theme === 'documentos' && index === 0 ? '2026-10-08T12:00:00Z' : '2026-10-27T12:00:00Z';
          await client.query(`INSERT INTO agente_protocolos_consultas
            (id, creado_en, usuario_id, cargo, pregunta, clasificacion, motivo_no_respuesta,
             area, tema, fuentes, validacion, resuelta_por_usuario)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
            `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`, createdAt,
            index % 3 + 1, index % 2 ? 'PMC' : 'Interiorista', `Pregunta ficticia ${sequence}`,
            classification, reason, theme === 'presupuesto' ? 'presupuestos' : 'obra', theme,
            JSON.stringify([{ name: 'Documento ficticio' }]), validation, solved,
          ]);
        }
      }
      expect(sequence).toBe(40);

      let previous = Promise.resolve();
      const pool = { query: (sql: string, parameters: unknown[]) => {
        const result = previous.then(() => client.query(sql, parameters));
        previous = result.then(() => undefined, () => undefined);
        return result;
      } } as unknown as Pool;
      const filters = parseProtocolReportFilters({}, new Date('2026-10-29T12:00:00Z'));
      const report = await loadProtocolReport(pool, filters);
      expect(report.total).toBe(38);
      expect(report.popular.find(row => row.tema === 'revisión semanal pmc')?.consultas).toBe(5);
      expect(report.popular.some(row => row.tema === 'plazo de pedido de material')).toBe(false);
      expect(report.unanswered.find(row => row.tema === 'protocolo ausente')).toMatchObject({
        consultas: 3, sin_protocolo: 1, rechazadas: 1, usuario_dijo_no: 1,
      });
      expect(report.unanswered.find(row => row.tema === 'recepción de obra')?.consultas).toBeGreaterThanOrEqual(1);
      expect(report.unanswered.every(row => (row.ejemplos as string[]).length <= 3)).toBe(true);
      expect(JSON.stringify(report)).not.toContain('usuario_id');

      const lowerThreshold = await loadProtocolReport(pool, { ...filters, minCount: 2 });
      expect(lowerThreshold.popular.find(row => row.tema === 'plazo de pedido de material')?.consultas).toBe(2);
      const area = await loadProtocolReport(pool, { ...filters, area: 'presupuestos' });
      expect(area.total).toBe(6);
      expect(area.popular.every(row => row.tema === 'presupuesto')).toBe(true);
      const role = await loadProtocolReport(pool, { ...filters, role: 'PMC' });
      expect(role.total).toBeLessThan(report.total);
      const empty = await loadProtocolReport(pool, parseProtocolReportFilters({ from: '2026-09-01', to: '2026-09-07' }));
      expect(empty).toEqual({ popular: [], unanswered: [], total: 0 });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  });
});
