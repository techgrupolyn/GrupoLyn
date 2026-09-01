import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';

type SourceProfile = {
  id: string;
  email: string | null;
  nombre: string;
  apellidos: string | null;
  rol: string | null;
  telefono: string | null;
  activo: boolean | null;
  updated_at: string | null;
};

type SourceProject = {
  id: string;
  nombre: string;
  descripcion: string | null;
  cliente_id: string | null;
  interiorista_id: string | null;
  estado: string | null;
  fecha_inicio: string | null;
  fecha_fin_estimada: string | null;
  fecha_fin_real: string | null;
  direccion: string | null;
  ciudad: string | null;
  activo: boolean | null;
  updated_at: string | null;
};

type SourceProjectMember = {
  id: string;
  proyecto_id: string;
  profile_id: string;
  rol_en_proyecto: string;
  created_at: string | null;
};

export type SupabaseDirectoryConfig = {
  url: string;
  key: string;
};

export type DirectorySyncResult = {
  profiles: number;
  employees: number;
  clients: number;
  projects: number;
  assignments: number;
  syncedAt: string;
};

const PAGE_SIZE = 1_000;

function normalizeRole(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function isClientRole(value: string | null | undefined): boolean {
  return normalizeRole(value) === 'cliente';
}

function normalizedPhone(value: string | null | undefined): string | null {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits : null;
}

function displayName(profile: Pick<SourceProfile, 'nombre' | 'apellidos'>): string {
  return [profile.nombre, profile.apellidos].map((value) => String(value || '').trim()).filter(Boolean).join(' ').trim();
}

function isConfigured(config: SupabaseDirectoryConfig): boolean {
  return Boolean(config.url && config.key);
}

export function supabaseDirectoryConfigFromEnv(env = process.env): SupabaseDirectoryConfig {
  return {
    url: String(env.SUPABASE_SOURCE_URL || '').trim().replace(/\/+$/, ''),
    key: String(env.SUPABASE_SOURCE_SECRET_KEY || '').trim(),
  };
}

async function fetchAll<T>(config: SupabaseDirectoryConfig, resource: string, select: string): Promise<T[]> {
  const result: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = new URL(`${config.url}/rest/v1/${resource}`);
    url.searchParams.set('select', select);
    url.searchParams.set('order', 'id.asc');
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('offset', String(offset));
    const response = await fetch(url, {
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
      },
    });
    if (!response.ok) throw new Error(`Supabase ${resource}: HTTP ${response.status}`);
    const rows = await response.json() as T[];
    result.push(...rows);
    if (rows.length < PAGE_SIZE) return result;
  }
}

async function upsertDirectory(client: PoolClient, profiles: SourceProfile[], projects: SourceProject[], assignments: SourceProjectMember[]): Promise<DirectorySyncResult> {
  const syncedAt = new Date().toISOString();
  const roles = new Set(profiles.map((profile) => normalizeRole(profile.rol)).filter(Boolean));
  for (const role of roles) {
    await client.query(
      `INSERT INTO roles (id, nombre, descripcion)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre, descripcion = EXCLUDED.descripcion`,
      [role, role.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()), 'Sincronizado desde Supabase'],
    );
  }

  const existingEmployeeNumbers = await client.query<{ id: string; numero: string | null }>(`SELECT id, numero FROM empleados WHERE numero IS NOT NULL`);
  const assignedNumbers = new Map(existingEmployeeNumbers.rows.map((row) => [String(row.numero), String(row.id)]));
  let employees = 0;
  let clients = 0;
  for (const profile of profiles) {
    const role = normalizeRole(profile.rol);
    if (isClientRole(role)) {
      clients++;
      await client.query(
        `INSERT INTO clientes (id, nombre, apellido, email, telefono, activo, source_updated_at, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (id) DO UPDATE SET
           nombre = EXCLUDED.nombre, apellido = EXCLUDED.apellido, email = EXCLUDED.email,
           telefono = EXCLUDED.telefono, activo = EXCLUDED.activo,
           source_updated_at = EXCLUDED.source_updated_at, synced_at = NOW()`,
        [profile.id, profile.nombre, profile.apellidos || null, profile.email || null, profile.telefono || null, profile.activo !== false, profile.updated_at || null],
      );
      continue;
    }
    employees++;
    const candidatePhone = normalizedPhone(profile.telefono);
    const existingOwner = candidatePhone ? assignedNumbers.get(candidatePhone) : null;
    const phone = candidatePhone && (!existingOwner || existingOwner === profile.id) ? candidatePhone : null;
    if (phone) assignedNumbers.set(phone, profile.id);
    await client.query(
      `INSERT INTO empleados (id, numero, nombre, apellido, empresa, email, activo, source_updated_at, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (id) DO UPDATE SET
         numero = EXCLUDED.numero, nombre = EXCLUDED.nombre, apellido = EXCLUDED.apellido,
         empresa = EXCLUDED.empresa, email = EXCLUDED.email, activo = EXCLUDED.activo,
         source_updated_at = EXCLUDED.source_updated_at, synced_at = NOW()`,
      [profile.id, phone, profile.nombre, profile.apellidos || null, 'Grupo LYN', profile.email || null, profile.activo !== false, profile.updated_at || null],
    );
    await client.query(
      `DELETE FROM usuario_rol
       WHERE empleado_id = $1
         AND rol_id IN (SELECT id FROM roles WHERE descripcion = 'Sincronizado desde Supabase')
         AND ($2::varchar IS NULL OR rol_id <> $2)`,
      [profile.id, role || null],
    );
    if (role) {
      await client.query(`INSERT INTO usuario_rol (empleado_id, rol_id) VALUES ($1, $2) ON CONFLICT (empleado_id, rol_id) DO NOTHING`, [profile.id, role]);
    }
  }

  for (const project of projects) {
    await client.query(
      `INSERT INTO proyectos (id, nombre, descripcion, cliente_id, interiorista_id, estado, fecha_inicio, fecha_fin_estimada, fecha_fin_real, direccion, ciudad, activo, source_updated_at, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       ON CONFLICT (id) DO UPDATE SET
         nombre = EXCLUDED.nombre, descripcion = EXCLUDED.descripcion, cliente_id = EXCLUDED.cliente_id,
         interiorista_id = EXCLUDED.interiorista_id, estado = EXCLUDED.estado, fecha_inicio = EXCLUDED.fecha_inicio,
         fecha_fin_estimada = EXCLUDED.fecha_fin_estimada, fecha_fin_real = EXCLUDED.fecha_fin_real,
         direccion = EXCLUDED.direccion, ciudad = EXCLUDED.ciudad, activo = EXCLUDED.activo,
         source_updated_at = EXCLUDED.source_updated_at, synced_at = NOW()`,
      [project.id, project.nombre, project.descripcion || null, project.cliente_id || null, project.interiorista_id || null, project.estado || null, project.fecha_inicio || null, project.fecha_fin_estimada || null, project.fecha_fin_real || null, project.direccion || null, project.ciudad || null, project.activo !== false, project.updated_at || null],
    );
  }

  const uniqueAssignments = new Map<string, SourceProjectMember>();
  for (const assignment of assignments) {
    const role = String(assignment.rol_en_proyecto || '').trim();
    const key = [assignment.proyecto_id, assignment.profile_id, role].join('\u0000');
    if (!uniqueAssignments.has(key)) uniqueAssignments.set(key, { ...assignment, rol_en_proyecto: role });
  }

  const assignmentIds = new Set<string>();
  for (const assignment of uniqueAssignments.values()) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO proyecto_asignaciones (id, proyecto_id, empleado_id, rol_en_proyecto, origen, source_created_at, synced_at)
       VALUES ($1, $2, $3, $4, 'supabase', $5, NOW())
       ON CONFLICT (proyecto_id, empleado_id, rol_en_proyecto) DO UPDATE SET
         source_created_at = EXCLUDED.source_created_at, synced_at = NOW()
       RETURNING id`,
      [assignment.id, assignment.proyecto_id, assignment.profile_id, assignment.rol_en_proyecto, assignment.created_at || null],
    );
    assignmentIds.add(result.rows[0].id);
  }
  await client.query(
    `DELETE FROM proyecto_asignaciones WHERE origen = 'supabase' AND NOT (id = ANY($1::varchar[]))`,
    [[...assignmentIds]],
  );
  await client.query(
    `INSERT INTO directory_sync_runs (id, source, status, profiles_count, projects_count, assignments_count, finished_at)
     VALUES ($1, 'supabase', 'success', $2, $3, $4, NOW())`,
    [randomUUID(), profiles.length, projects.length, uniqueAssignments.size],
  );
  return { profiles: profiles.length, employees, clients, projects: projects.length, assignments: uniqueAssignments.size, syncedAt };
}

export async function syncSupabaseDirectory(pool: Pool, config = supabaseDirectoryConfigFromEnv()): Promise<DirectorySyncResult> {
  if (!isConfigured(config)) throw new Error('La conexión de Supabase no está configurada');
  const [profiles, projects, assignments] = await Promise.all([
    fetchAll<SourceProfile>(config, 'profiles', 'id,email,nombre,apellidos,rol,telefono,activo,updated_at'),
    fetchAll<SourceProject>(config, 'proyectos', 'id,nombre,descripcion,cliente_id,interiorista_id,estado,fecha_inicio,fecha_fin_estimada,fecha_fin_real,direccion,ciudad,activo,updated_at'),
    fetchAll<SourceProjectMember>(config, 'proyecto_miembros', 'id,proyecto_id,profile_id,rol_en_proyecto,created_at'),
  ]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await upsertDirectory(client, profiles, projects, assignments);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    await client.query(
      `INSERT INTO directory_sync_runs (id, source, status, error_message, finished_at)
       VALUES ($1, 'supabase', 'error', $2, NOW())`,
      [randomUUID(), (error as Error).message.slice(0, 1_000)],
    ).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type MeetingDirectoryCandidate = {
  project_id: string;
  project_name: string;
  client_id: string | null;
  client_name: string | null;
  employee_id: string | null;
  employee_name: string | null;
  employee_role: string | null;
  role_in_project: string | null;
  project_aliases?: string[];
};

export function meetingDirectoryContext(rows: MeetingDirectoryCandidate[]): string {
  return rows.map((row) => [
    `Proyecto: ${row.project_name} [project_id:${row.project_id}]`,
    row.client_name ? `Cliente: ${row.client_name}${row.client_id ? ` [client_id:${row.client_id}]` : ''}` : '',
    row.employee_name ? `Responsable: ${row.employee_name}${row.employee_id ? ` [employee_id:${row.employee_id}]` : ''}` : '',
    row.role_in_project || row.employee_role ? `Rol: ${row.role_in_project || row.employee_role}` : '',
  ].filter(Boolean).join(' · ')).join('\n');
}

export { displayName };


