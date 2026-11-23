// Usuarios locales del superagente con el rol consultor_lectura (p. ej. una agencia de marketing): ven Netelip › Historial de
// llamadas y Gestión de reuniones en solo lectura. No existen en Club LYN ni en Supabase: entran con usuario y contraseña en el
// login del Dashboard. Se gestionan con scripts/usuario-consultor.ts.
import { hashPassword } from './contrasenas.ts';
import { ROL_CONSULTOR } from './rol-consultor.ts';

type Db = { query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount?: number | null }> };

export const LONGITUD_MINIMA_CONTRASENA = 12;

export class UsuarioConsultorInvalido extends Error {}

export type UsuarioConsultor = { usuario: string; nombre: string | null; rol: string; activo: boolean };

function validar(entrada: { usuario: string; nombre: string; contrasena: string }) {
  const usuario = entrada.usuario.trim();
  // Sin «@»: los correos van al login del directorio (Supabase) y se confundirían con una cuenta de empresa.
  if (!/^[a-zA-Z0-9._-]{3,60}$/.test(usuario)) throw new UsuarioConsultorInvalido('El usuario debe tener de 3 a 60 caracteres: letras, números, punto, guion o guion bajo (sin «@»).');
  const nombre = entrada.nombre.trim().slice(0, 255);
  if (!nombre) throw new UsuarioConsultorInvalido('Indica el nombre de la persona o de la empresa.');
  if (entrada.contrasena.length < LONGITUD_MINIMA_CONTRASENA) throw new UsuarioConsultorInvalido(`La contraseña debe tener al menos ${LONGITUD_MINIMA_CONTRASENA} caracteres.`);
  return { usuario, nombre };
}

/** Usuario existente con ese nombre que NO es consultor: no se toca (no se puede convertir a un admin en consultor). */
async function comprobarQueEsConsultor(db: Db, usuario: string): Promise<UsuarioConsultor | null> {
  const { rows: [actual] } = await db.query<UsuarioConsultor & { auth_provider: string | null }>(
    'SELECT usuario, nombre, rol, activo, auth_provider FROM usuarios WHERE usuario = $1', [usuario]);
  if (!actual) return null;
  if ((actual.auth_provider || 'local') !== 'local' || actual.rol !== ROL_CONSULTOR) {
    throw new UsuarioConsultorInvalido(`Ya existe el usuario «${usuario}» con otro tipo de acceso; elige otro nombre de usuario.`);
  }
  return actual;
}

/** Crea el usuario o, si ya es consultor, le cambia nombre y contraseña y lo reactiva. */
export async function guardarUsuarioConsultor(db: Db, entrada: { usuario: string; nombre: string; contrasena: string }): Promise<{ usuario: UsuarioConsultor; creado: boolean }> {
  const { usuario, nombre } = validar(entrada);
  const actual = await comprobarQueEsConsultor(db, usuario);
  const hash = hashPassword(entrada.contrasena);
  const { rows: [fila] } = actual
    ? await db.query<UsuarioConsultor>(
      `UPDATE usuarios SET nombre = $2, password_hash = $3, contraseña = '', activo = TRUE WHERE usuario = $1
       RETURNING usuario, nombre, rol, activo`, [usuario, nombre, hash])
    : await db.query<UsuarioConsultor>(
      `INSERT INTO usuarios (usuario, contraseña, password_hash, nombre, rol, activo, auth_provider) VALUES ($1, '', $2, $3, $4, TRUE, 'local')
       RETURNING usuario, nombre, rol, activo`, [usuario, hash, nombre, ROL_CONSULTOR]);
  return { usuario: fila, creado: !actual };
}

/** Desactiva el usuario: no puede volver a entrar (la sesión abierta caduca sola, CEO_SESSION_TTL_MS). */
export async function desactivarUsuarioConsultor(db: Db, usuario: string): Promise<boolean> {
  const actual = await comprobarQueEsConsultor(db, usuario.trim());
  if (!actual) return false;
  await db.query('UPDATE usuarios SET activo = FALSE WHERE usuario = $1', [actual.usuario]);
  return true;
}

export async function listarUsuariosConsultor(db: Db): Promise<UsuarioConsultor[]> {
  const { rows } = await db.query<UsuarioConsultor>(
    `SELECT usuario, nombre, rol, activo FROM usuarios WHERE rol = $1 AND COALESCE(auth_provider, 'local') = 'local' ORDER BY usuario`,
    [ROL_CONSULTOR]);
  return rows;
}
