import { describe, expect, it } from 'vitest';
import { meetingDirectoryContext, supabaseDirectoryConfigFromEnv } from '../supabase-directory.ts';

describe('Directorio empresarial de Supabase', () => {
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