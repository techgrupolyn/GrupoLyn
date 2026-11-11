import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { ensureProtocolSchema, loadRestrictedProtocolFiles, saveProtocolCorpus, saveRestrictedProtocolFiles } from '../protocol-storage.ts';
import { createProtocolCorpus } from '../protocol-corpus.ts';

const restrictedFile = {
  id: 'private-1', name: 'Cotizador', mimeType: 'text/plain', audience: 'restricted' as const,
  modifiedTime: '2026-11-11T00:00:00Z', revision: '1', warnings: [],
  sections: [{ ref: 'hoja 1', text: 'Importe de la obra: 1200 euros' }],
};

describe('almacenamiento restringido de protocolos', () => {
  it('revoca acceso público y de los roles Supabase a las tablas privadas', async () => {
    const previousFolder = process.env.PROTOCOL_LEGACY_DRIVE_FOLDER_ID;
    process.env.PROTOCOL_LEGACY_DRIVE_FOLDER_ID = 'carpeta-prueba';
    const query = vi.fn(async () => ({ rows: [] }));
    try {
      await ensureProtocolSchema({ query } as unknown as Pool);
      const sql = String(query.mock.calls[1][0]);
      expect(sql).toContain('REVOKE ALL ON SCHEMA protocol_private FROM PUBLIC');
      expect(sql).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA protocol_private FROM anon');
      expect(sql).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA protocol_private FROM authenticated');
    } finally {
      if (previousFolder === undefined) delete process.env.PROTOCOL_LEGACY_DRIVE_FOLDER_ID;
      else process.env.PROTOCOL_LEGACY_DRIVE_FOLDER_ID = previousFolder;
    }
  });

  it('no consulta la tabla privada para perfiles sin permiso', async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;
    expect(await loadRestrictedProtocolFiles(pool, 'employee:interiorista')).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('solo carga documentos privados tras autorizar Dirección, admin o admin verificado de Club', async () => {
    const query = vi.fn(async () => ({ rows: [{ archivo: restrictedFile }] }));
    const pool = { query } as unknown as Pool;
    expect(await loadRestrictedProtocolFiles(pool, 'employee:director')).toEqual([restrictedFile]);
    expect(await loadRestrictedProtocolFiles(pool, 'ceo')).toEqual([restrictedFile]);
    expect(await loadRestrictedProtocolFiles(pool, 'admin')).toEqual([restrictedFile]);
    expect(await loadRestrictedProtocolFiles(pool, 'employee:pmc', true)).toEqual([restrictedFile]);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('impide guardar datos restringidos en el corpus general', async () => {
    const pool = { connect: vi.fn() } as unknown as Pool;
    const corpus = createProtocolCorpus([restrictedFile], 1000);
    await expect(saveProtocolCorpus(pool, corpus)).rejects.toThrow('solo admite documentos aprobados');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('impide guardar documentos generales en la tabla privada', async () => {
    const pool = { connect: vi.fn() } as unknown as Pool;
    await expect(saveRestrictedProtocolFiles(pool, [{ ...restrictedFile, audience: 'general' }])).rejects.toThrow('Solo se admiten documentos restringidos');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('activa una generación completa solo después de guardar sus documentos', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const release = vi.fn();
    const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
    await saveRestrictedProtocolFiles(pool, [restrictedFile]);
    expect(query.mock.calls.map(([sql]) => String(sql).trim().split(' ')[0])).toEqual(['BEGIN', 'INSERT', 'INSERT', 'COMMIT']);
    expect(String(query.mock.calls[2][0])).toContain('active_generation');
    expect(release).toHaveBeenCalledOnce();
  });

  it('revierte la generación incompleta sin alterar la activa', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('protocol_private.documents')) throw new Error('Fallo de escritura');
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
    await expect(saveRestrictedProtocolFiles(pool, [restrictedFile])).rejects.toThrow('Fallo de escritura');
    expect(query.mock.calls.map(([sql]) => String(sql).trim().split(' ')[0])).toEqual(['BEGIN', 'INSERT', 'ROLLBACK']);
    expect(release).toHaveBeenCalledOnce();
  });
});
