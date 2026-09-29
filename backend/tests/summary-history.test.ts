import { describe, expect, it } from 'vitest';
import { publicSummaryJob } from '../summary-jobs.ts';

describe('estado público de recuperación de historial', () => {
  it('explica la falta de referencia sin mostrar un porcentaje de análisis ficticio', () => {
    const result = publicSummaryJob({ id: 'qa', account_id: 'qa', specialist_id: 'general', attempts: 0,
      status: 'queued', error: null, result: {
        progress: { stage: 'syncing', completedMessages: 0, totalMessages: 0, completedBatches: 0, totalBatches: 0 },
        historyRecovery: [{ group: 'qa@g.us', status: 'no_anchor' }],
      } });
    expect(result.en_progreso).toBe(true);
    expect(result.resumen).toContain('mensaje de referencia en 1 grupos');
    expect(result.resumen).toContain('No se puede solicitar');
    expect(result.resumen).not.toContain('automáticamente');
    expect(result.resumen).not.toContain('100');
  });
});
