import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { hasClubAdminRole } from '../protocol-privacy.ts';

const databaseUrl = process.env.PROTOCOL_REPORT_TEST_DATABASE_URL;
const localDatabase = databaseUrl && ['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname);

describe.skipIf(!localDatabase)('acceso al historial por rol administrativo de Club', () => {
  it('autoriza solo perfiles activos con rol admin o superadmin de Supabase', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`
        CREATE TEMP TABLE usuarios(id INTEGER PRIMARY KEY,email TEXT,activo BOOLEAN,auth_provider TEXT);
        CREATE TEMP TABLE empleados(id TEXT PRIMARY KEY,email TEXT,activo BOOLEAN);
        CREATE TEMP TABLE usuario_rol(empleado_id TEXT,rol_id TEXT);
        INSERT INTO usuarios VALUES
          (1,'admin@example.test',TRUE,'supabase'),
          (2,'super@example.test',TRUE,'supabase'),
          (3,'member@example.test',TRUE,'supabase'),
          (4,'inactive@example.test',FALSE,'supabase'),
          (5,'local@example.test',TRUE,'local');
        INSERT INTO empleados VALUES
          ('admin','admin@example.test',TRUE),
          ('super','super@example.test',TRUE),
          ('member','member@example.test',TRUE),
          ('inactive','inactive@example.test',TRUE),
          ('local','local@example.test',TRUE);
        INSERT INTO usuario_rol VALUES
          ('admin','admin'),('super','superadmin'),('member','employee'),
          ('inactive','admin'),('local','admin');
      `);
      const query = (sql: string, params: [number]) => client.query<{ allowed: boolean }>(sql, params);
      expect(await hasClubAdminRole(query, 1)).toBe(true);
      expect(await hasClubAdminRole(query, 2)).toBe(true);
      expect(await hasClubAdminRole(query, 3)).toBe(false);
      expect(await hasClubAdminRole(query, 4)).toBe(false);
      expect(await hasClubAdminRole(query, 5)).toBe(false);
    } finally {
      await client.end();
    }
  });
});
