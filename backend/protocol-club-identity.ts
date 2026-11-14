import type { Pool } from 'pg';

export async function resolveProtocolClubIdentity(
  pool: Pool,
  externalId: string,
  roleFromPosition: (role: string | null) => string,
): Promise<{ id: number; externalId: string; role: string } | null> {
  const employee = await pool.query<{ role_id: string | null }>(
    `SELECT COALESCE(org_cargo.nombre, MIN(r.id)) AS role_id
     FROM empleados e
     LEFT JOIN usuario_rol ur ON ur.empleado_id=e.id
     LEFT JOIN roles r ON r.id=ur.rol_id
     LEFT JOIN LATERAL (
       SELECT oc.nombre FROM organigrama_cargo_asignaciones oca
       JOIN organigrama_cargos oc ON oc.id=oca.cargo_id
       WHERE oca.empleado_id=e.id AND oca.activo=TRUE AND oc.activo=TRUE
       ORDER BY CASE WHEN LOWER(oc.nombre)='director general' THEN 4 WHEN LOWER(oc.nombre)='direccion de operaciones' THEN 3 WHEN LOWER(oc.nombre) LIKE '%pmc%' THEN 2 ELSE 0 END DESC, oc.nombre
       LIMIT 1
     ) org_cargo ON TRUE
     WHERE e.id=$1 AND e.activo=TRUE
     GROUP BY e.id,org_cargo.nombre LIMIT 1`,
    [externalId],
  );
  if (!employee.rows.length) return null;
  const role = roleFromPosition(employee.rows[0].role_id);
  const username = `sb_${externalId.replace(/-/gu, '')}`;
  const account = await pool.query<{ id: number; rol: string }>(
    `INSERT INTO usuarios (usuario, contraseña, password_hash, rol, activo, auth_provider, external_auth_user_id)
     VALUES ($1, '', '', $2, TRUE, 'supabase', $3)
     ON CONFLICT (auth_provider, external_auth_user_id) WHERE external_auth_user_id IS NOT NULL
     DO UPDATE SET rol=EXCLUDED.rol WHERE usuarios.activo=TRUE
     RETURNING id, rol`,
    [username, role, externalId],
  );
  return account.rows[0] ? { id: account.rows[0].id, externalId, role: account.rows[0].rol } : null;
}
