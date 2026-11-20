// Repaso de las llamadas de Netelip ya registradas (N-1.0, ticket 1an2gnq0c77). Desde backend/:
//
//   npx tsx netelip/captacion/vinculo-cli.ts
//
// Lee los leads de «Contacto de Reforma» (solo lectura) y asocia a su tarjeta todas las llamadas que aún no tengan lead: por teléfono y,
// si no coincide, por email. Las que coinciden con varias tarjetas NO se asignan solas: quedan en la lista «sin asignar» del Dashboard.
// Lo asignado a mano no se toca. Repetirlo es seguro. Lo único que escribe es la tabla `captacion_llamada_lead`; ClickUp no se toca.
// Variables: DATABASE_URL, CLICKUP_API_TOKEN y CAPTACION_CLICKUP_LIST_ID. La salida lleva solo totales, sin nombres ni teléfonos.
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { ClickUpClient, clickupConfigDesdeEnv } from './clickup.ts';
import { ensureCaptacion } from './schema.ts';
import { VinculadorLlamadas, type ResumenVinculo } from './vinculo-llamadas.ts';

export function resumenVinculo(r: ResumenVinculo, totales: Record<string, number>): string {
  const t = (k: string) => totales[k] ?? 0;
  return [
    `Llamadas revisadas en esta pasada: ${r.revisadas} · asociadas a su lead: ${r.vinculadas} · con varias coincidencias (a asignar a mano): ${r.variasCoincidencias} · sin coincidencia: ${r.sinCoincidencia} · sin teléfono ni email: ${r.sinDatos}`,
    `Estado total de las llamadas: vinculadas ${t('vinculada')} · varias coincidencias ${t('varias_coincidencias')} · sin coincidencia ${t('sin_coincidencia')} · sin datos ${t('sin_datos')}`,
  ].join('\n');
}

export async function mainVinculo(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('Falta DATABASE_URL');
  const config = clickupConfigDesdeEnv(env);
  if (!config) throw new Error('Faltan CLICKUP_API_TOKEN y/o CAPTACION_CLICKUP_LIST_ID');
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await ensureCaptacion(pool);
    const resumen = await new VinculadorLlamadas({ pool, cliente: new ClickUpClient(config), registro: (m) => console.log(m) }).repasarTodo();
    const { rows } = await pool.query<{ estado: string; n: string }>('SELECT estado, COUNT(*) AS n FROM captacion_llamada_lead GROUP BY estado');
    console.log(resumenVinculo(resumen, Object.fromEntries(rows.map((r) => [r.estado, Number(r.n)]))));
    return 0;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mainVinculo().then((codigo) => process.exit(codigo), (error) => {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  });
}
