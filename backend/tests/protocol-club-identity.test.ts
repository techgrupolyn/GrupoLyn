import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { resolveProtocolClubIdentity } from '../protocol-club-identity.ts';

const externalId = 'f779edfa-645e-455c-8b82-2e3e229a1d4a';

describe('identidad del puente de Club LYN', () => {
  it('rechaza usuarios que no son empleados activos', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const result = await resolveProtocolClubIdentity({ query } as unknown as Pool, externalId, () => 'employee:member');
    expect(result).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('e.activo=TRUE');
    expect(query.mock.calls[0][1]).toEqual([externalId]);
  });

  it('obtiene el cargo del directorio y conserva cuentas desactivadas', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ role_id: 'Interiorista' }] }).mockResolvedValueOnce({ rows: [{ id: 42, rol: 'employee:interiorista' }] });
    const result = await resolveProtocolClubIdentity({ query } as unknown as Pool, externalId, role => `employee:${role?.toLowerCase()}`);
    expect(result).toEqual({ id: 42, externalId, role: 'employee:interiorista' });
    expect(query.mock.calls[1][0]).toContain('WHERE usuarios.activo=TRUE');
    expect(query.mock.calls[1][1]).toEqual(['sb_f779edfa645e455c8b822e3e229a1d4a', 'employee:interiorista', externalId]);

    const inactive = vi.fn().mockResolvedValueOnce({ rows: [{ role_id: 'Interiorista' }] }).mockResolvedValueOnce({ rows: [] });
    expect(await resolveProtocolClubIdentity({ query: inactive } as unknown as Pool, externalId, () => 'employee:interiorista')).toBeNull();
  });
});
