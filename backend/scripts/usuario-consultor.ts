// Usuarios del superagente con el rol consultor_lectura: ven Netelip › Historial de llamadas y Gestión de reuniones, en solo
// lectura. Ver docs/NETELIP_LLAMADAS.md («Acceso de consulta para personas de fuera»).
//   npx tsx --env-file=.env scripts/usuario-consultor.ts listar
//   npx tsx --env-file=.env scripts/usuario-consultor.ts guardar --usuario agencia.ejemplo --nombre "Agencia Ejemplo"
//   npx tsx --env-file=.env scripts/usuario-consultor.ts desactivar --usuario agencia.ejemplo
// «guardar» pide la contraseña sin mostrarla (o la lee de CONTRASENA_USUARIO_CONSULTOR). Nunca la escribe en pantalla ni en logs.
import { createInterface } from 'node:readline';
import pg from 'pg';
import { desactivarUsuarioConsultor, guardarUsuarioConsultor, listarUsuariosConsultor, UsuarioConsultorInvalido } from '../usuarios-consultor.ts';

const [orden, ...resto] = process.argv.slice(2);
const opcion = (nombre: string) => { const i = resto.indexOf(`--${nombre}`); return i >= 0 ? resto[i + 1] : undefined; };

function pedirContrasena(pregunta: string): Promise<string> {
  if (process.env.CONTRASENA_USUARIO_CONSULTOR) return Promise.resolve(process.env.CONTRASENA_USUARIO_CONSULTOR);
  if (!process.stdin.isTTY) throw new UsuarioConsultorInvalido('Sin terminal: pasa la contraseña en CONTRASENA_USUARIO_CONSULTOR.');
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let mostrada = false;
    // Muestra la pregunta y oculta lo que se teclea.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => { if (!mostrada) { process.stdout.write(s); mostrada = true; } };
    rl.question(pregunta, (valor) => { rl.close(); process.stdout.write('\n'); resolve(valor); });
  });
}

async function main(pool: pg.Pool) {
  switch (orden) {
    case 'listar': {
      const usuarios = await listarUsuariosConsultor(pool);
      if (!usuarios.length) console.log('No hay usuarios consultores.');
      for (const u of usuarios) console.log(`${u.activo ? '●' : '○'} ${u.usuario.padEnd(24)} ${u.nombre || ''}`);
      return;
    }
    case 'guardar': {
      const contrasena = await pedirContrasena('Contraseña (mín. 12 caracteres): ');
      if (!process.env.CONTRASENA_USUARIO_CONSULTOR && contrasena !== await pedirContrasena('Repítela: ')) throw new UsuarioConsultorInvalido('Las contraseñas no coinciden.');
      const { usuario, creado } = await guardarUsuarioConsultor(pool, { usuario: opcion('usuario') || '', nombre: opcion('nombre') || '', contrasena });
      console.log(`${creado ? 'Creado' : 'Actualizado'} «${usuario.usuario}» (${usuario.rol}). Entra en el Dashboard con ese usuario y su contraseña.`);
      return;
    }
    case 'desactivar': {
      const hecho = await desactivarUsuarioConsultor(pool, opcion('usuario') || '');
      console.log(hecho ? 'Usuario desactivado: ya no puede entrar (la sesión abierta caduca sola).' : 'No existe ese usuario.');
      return;
    }
    default:
      console.log('Uso: usuario-consultor.ts listar | guardar --usuario U --nombre "N" | desactivar --usuario U');
      process.exitCode = 1;
  }
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
main(pool)
  .catch((error) => {
    console.error(error instanceof UsuarioConsultorInvalido ? error.message : `Error: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
