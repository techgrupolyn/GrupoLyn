// Base aislada para las pruebas de la captación ABCD: un esquema de Postgres propio por prueba, que se
// borra al terminar. Solo corre contra la base de QA local (mismo guard que el resto de pruebas con base
// de datos); sin QA_TEST_DATABASE_URL las pruebas que la usan se saltan.
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

export const hayBaseDePruebas = Boolean(process.env.QA_TEST_DATABASE_URL);

export class BaseAislada {
  constructor(private readonly cliente: Client, readonly esquema: string) {}

  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    return this.cliente.query(sql, params) as unknown as Promise<{ rows: T[] }>;
  }

  /** Varias sentencias seguidas (sin parámetros). */
  async exec(sql: string): Promise<void> {
    await this.cliente.query(sql);
  }

  async cerrar(): Promise<void> {
    try {
      await this.cliente.query('ROLLBACK').catch(() => undefined);
      // La ruta de búsqueda se restablece antes de borrar el esquema: si la sesión se comparte (como con
      // PGlite), no puede quedar apuntando a un esquema que ya no existe.
      await this.cliente.query('RESET search_path');
      await this.cliente.query(`DROP SCHEMA IF EXISTS ${this.esquema} CASCADE`);
    } finally {
      await this.cliente.end();
    }
  }
}

export async function abrirBaseAislada(): Promise<BaseAislada> {
  const url = new URL(process.env.QA_TEST_DATABASE_URL ?? '');
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/lyn_qa_retest') throw new Error('Solo QA local');
  const cliente = new Client({ connectionString: url.toString() });
  await cliente.connect();
  const esquema = `captacion_t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  try {
    await cliente.query(`CREATE SCHEMA ${esquema}`);
    // Sin «public» en la ruta: nada de lo que se cree o borre aquí puede tocar tablas de la base de QA. «pg_temp» va
    // al final a propósito: por defecto Postgres lo busca PRIMERO, y si la sesión se comparte (PGlite) las tablas
    // temporales que dejan otras pruebas (empleados, clientes…) taparían las de este esquema.
    await cliente.query(`SET search_path TO ${esquema}, pg_temp`);
  } catch (error) {
    await cliente.end().catch(() => undefined);
    throw error;
  }
  return new BaseAislada(cliente, esquema);
}
