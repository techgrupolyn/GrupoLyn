import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { backfillMeetingDirectoryTags, pool } from '../server.ts';
import { linkUnassignedMeetingActions } from '../meeting-action-linking.ts';

afterEach(() => vi.restoreAllMocks());
afterAll(() => pool.end());

describe('sincronización cooperativa de reuniones', () => {
  it.each([false, true])('cede entre reuniones sin cambios, revisión manual=%s', async (manual) => {
    let processed = 0;
    const checkpoints: number[] = [];
    const reviews = Array.from({ length: 120 }, () => ({
      get source_name() {
        processed += 1;
        setImmediate(() => checkpoints.push(processed));
        return 'Sesión sin referencias';
      },
      project_name: null, contact_name: null, pmc: null, project_id: null,
      contact_id: null, pmc_employee_id: null, directory_match_confidence: null,
      manual_revision: manual, pmc_assignments: [], metadata: {}, content_text: '',
    }));
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE OF r SKIP LOCKED')) return { rows: reviews };
      if (sql.includes('FROM meeting_review_actions ma')) {
        expect(checkpoints.length).toBeGreaterThan(0);
        expect(checkpoints[0]).toBeLessThan(processed);
      }
      return { rows: [] };
    });
    const release = vi.fn();
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ project_id: 'synthetic', project_name: 'Proyecto aislado' }] } as never);
    vi.spyOn(pool, 'connect').mockResolvedValue({ query, release } as never);
    const result = await backfillMeetingDirectoryTags();
    expect(result).toEqual({ reviewsScanned: 120, reviewsTagged: 0, actionsScanned: 0, actionsTagged: 0 });
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('cede también cuando ninguna acción tiene una coincidencia inequívoca', async () => {
    let processed = 0;
    const checkpoints: number[] = [];
    const actions = Array.from({ length: 1000 }, () => ({
      get responsible() {
        processed += 1;
        setImmediate(() => checkpoints.push(processed));
        return 'Sin asignar';
      },
    }));
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM meeting_review_actions action') ? actions : [] }));
    const result = await linkUnassignedMeetingActions({ query } as unknown as PoolClient);
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints[0]).toBeLessThan(processed);
    expect(processed).toBe(1000);
    expect(result).toEqual({ scanned: 1000, linked: [] });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
