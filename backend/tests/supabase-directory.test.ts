import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { Pool as PgPool } from 'pg';
import { meetingDirectoryContext, supabaseDirectoryConfigFromEnv, syncSupabaseDirectory } from '../supabase-directory.ts';

describe('Directorio empresarial de Supabase', () => {
  it.skipIf(!process.env.QA_TEST_DATABASE_URL)('reconcilia cambios e intercambios de cargo con el mismo id sin perder asignaciones manuales', async () => {
    const url = new URL(process.env.QA_TEST_DATABASE_URL!);
    if (url.hostname!=='127.0.0.1' || url.pathname!=='/lyn_qa_retest') throw Error('Solo QA local');
    const realPool = new PgPool({connectionString:url.toString(),max:1});
    const client = await realPool.connect();
    const members = [
      {id:'first',proyecto_id:'project',profile_id:'employee',rol_en_proyecto:'PMC',created_at:'2026-10-15T12:00:00Z'},
      {id:'second',proyecto_id:'project',profile_id:'employee',rol_en_proyecto:'delineante',created_at:'2026-10-14T12:00:00Z'},
    ];
    vi.stubGlobal('fetch',vi.fn(async (url:URL,options:RequestInit)=>{
      expect(options.method||'GET').toBe('GET');
      return {ok:true,json:async()=>url.pathname.endsWith('/proyecto_miembros')?members:[]};
    }));
    try {
      for (const table of ['roles','clientes','empleados','usuario_rol','proyectos','organigrama_cargos','organigrama_cargo_roles','organigrama_cargo_asignaciones','proyecto_asignaciones','directory_sync_runs']) await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      await client.query(`INSERT INTO proyecto_asignaciones(id,proyecto_id,empleado_id,rol_en_proyecto,origen,created_at) VALUES
        ('supabase:first','project','employee','delineante','supabase','2026-09-01T00:00:00Z'),
        ('supabase:second','project','employee','PMC','supabase','2026-09-02T00:00:00Z'),
        ('manual','project','other','PMC','manual','2026-09-03T00:00:00Z')`);
      const pool = {connect:async()=>({query:client.query.bind(client),release:()=>{}})} as unknown as Pool;
      await syncSupabaseDirectory(pool,{url:'https://club.example.test',key:'test-only'});
      const first = (await client.query('SELECT id,rol_en_proyecto,created_at,source_created_at FROM proyecto_asignaciones ORDER BY id')).rows;
      expect(first.map(row=>[row.id,row.rol_en_proyecto])).toEqual([['manual','PMC'],['supabase:first','PMC'],['supabase:second','delineante']]);
      expect(first[1].created_at.toISOString()).toBe('2026-09-01T00:00:00.000Z');
      expect(first[1].source_created_at.toISOString()).toBe('2026-10-15T12:00:00.000Z');
      await syncSupabaseDirectory(pool,{url:'https://club.example.test',key:'test-only'});
      expect((await client.query('SELECT id,rol_en_proyecto,created_at,source_created_at FROM proyecto_asignaciones ORDER BY id')).rows).toEqual(first);
      expect((await client.query("SELECT COUNT(*) FROM directory_sync_runs WHERE status='success'")).rows[0].count).toBe('2');
    } finally { vi.unstubAllGlobals(); client.release(); await realPool.end(); }
  });
  it('importa la fecha de asignación real sin usar updated_at ni enviar escrituras a Club', async () => {
    const source: Record<string, unknown[]> = {
      cargos:[{id:'cargo',nombre:'PMC',codigo:'uuid-code',tipo_equipo_proyecto:'pmc'}],
      cargo_asignaciones:[{id:'assignment',cargo_id:'cargo',profile_id:'employee',proyecto_id:'project',asignado_at:'2026-10-01T12:00:00Z',updated_at:'2026-10-14T12:00:00Z'}],
      proyecto_miembros:[
        {id:'old',proyecto_id:'project',profile_id:'employee',rol_en_proyecto:'pmc',created_at:'2026-09-01T12:00:00Z'},
        {id:'new',proyecto_id:'project',profile_id:'employee',rol_en_proyecto:'pmc',created_at:'2026-10-02T12:00:00Z'},
      ],
    };
    const fetcher = vi.fn(async (url: URL, options: RequestInit) => {
      expect(options.method || 'GET').toBe('GET');
      if (url.pathname.endsWith('/cargo_asignaciones')) expect(url.searchParams.get('select')).toContain('asignado_at');
      if (url.pathname.endsWith('/cargos')) expect(url.searchParams.get('select')).toContain('tipo_equipo_proyecto');
      return {ok:true,json:async () => source[url.pathname.split('/').at(-1)!] || []};
    });
    const query = vi.fn(async (sql: string) => ({rows:sql === 'SELECT id FROM empleados' ? [{id:'employee'}] : sql.includes('RETURNING id') ? [{id:'stored-member'}] : []}));
    vi.stubGlobal('fetch',fetcher);
    try {
      const pool = {connect:async () => ({query,release:vi.fn()})} as unknown as Pool;
      await syncSupabaseDirectory(pool,{url:'https://club.example.test',key:'test-only'});
      const calls = query.mock.calls as unknown as [string, unknown[]][];
      expect(calls.find(([sql]) => sql.includes('INSERT INTO organigrama_cargo_asignaciones'))![1][6]).toBe('2026-10-01T12:00:00Z');
      expect(calls.find(([sql]) => sql.includes('INSERT INTO organigrama_cargos'))![1][9]).toBe('pmc');
      expect(calls.find(([sql]) => sql.includes('INSERT INTO proyecto_asignaciones'))![1][4]).toBe('2026-10-02T12:00:00Z');
      expect(fetcher).toHaveBeenCalledTimes(6);
    } finally { vi.unstubAllGlobals(); }
  });
  it('normaliza la URL de origen', () => {
    const config = supabaseDirectoryConfigFromEnv({
      SUPABASE_SOURCE_URL: 'https://supabase.example.test///',
      SUPABASE_SOURCE_SECRET_KEY: 'clave-de-prueba',
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({ url: 'https://supabase.example.test', key: 'clave-de-prueba' });
  });

  it('construye candidatos de reunión con identificadores locales verificables', () => {
    const context = meetingDirectoryContext([{
      project_id: 'f0a5c83a-b916-4b52-9724-66b0ed8e0af7', project_name: 'Ático Albir',
      client_id: 'f2b76331-1cc5-4582-8b01-7731f07d63fd', client_name: 'Javier Ruiz',
      employee_id: 'b30b7fc5-812a-4c5b-9d6d-d5cfe0bd1d4c', employee_name: 'Laura Martínez',
      employee_role: 'Directora', role_in_project: 'pmc',
    }]);

    expect(context).toContain('project_id:f0a5c83a-b916-4b52-9724-66b0ed8e0af7');
    expect(context).toContain('employee_id:b30b7fc5-812a-4c5b-9d6d-d5cfe0bd1d4c');
    expect(context).toContain('Ático Albir');
    expect(context).toContain('Laura Martínez');
  });
});
