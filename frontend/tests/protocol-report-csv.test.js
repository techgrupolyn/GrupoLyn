import { describe, expect, it } from 'vitest';
import { protocolReportCsv } from '../src/ceo-dashboard/protocol-report-csv.js';

describe('exportación de reporte de protocolos', () => {
  it('conserva columnas, filas y protege celdas que Excel interpretaría como fórmulas', () => {
    const csv = protocolReportCsv([{ tema: '=IMPORTXML("https://example.com")', consultas: 2, cargos: ['PMC', 'Dirección'], ejemplos: ['Pregunta, con coma'] }], 'unanswered');
    expect(csv).toContain('"\'=IMPORTXML(""https://example.com"")"');
    expect(csv).toContain('"PMC | Dirección"');
    expect(csv).toContain('"Pregunta, con coma"');
  });
});
