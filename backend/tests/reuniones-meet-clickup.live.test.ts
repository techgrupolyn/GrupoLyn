// Búsqueda del lead contra CLICKUP REAL, solo lectura (869fppbcj). Solo se ejecuta a propósito:
//   QA_LIVE_REUNIONES_CLICKUP=true CLICKUP_API_TOKEN=pk_… QA_CLICKUP_EMAIL_LEAD=<email de un lead de la lista> \
//     npx vitest run tests/reuniones-meet-clickup.live.test.ts
// Comprueba los supuestos tomados del ticket sin acceso a la lista: que existen los campos `email` y `ETAPA_CRM` (o los
// configurados), qué opciones tiene ETAPA_CRM y que el filtro por email encuentra un lead. Solo permite GET a
// api.clickup.com: cualquier escritura o cualquier otro destino hacen fallar la prueba. No imprime datos de clientes:
// solo nombres de campos, opciones de etapa y el id de la tarea encontrada.
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configClickUpDesdeEnv, crearBuscadorLeads } from '../reuniones-meet/clickup.ts';
import { faseDeEtapa } from '../reuniones-meet/reglas.ts';

const ACTIVO = process.env.QA_LIVE_REUNIONES_CLICKUP === 'true';

describe.skipIf(!ACTIVO)('Lead en «Contacto de Reforma» con ClickUp real (solo lectura)', () => {
  let fetchOriginal: typeof fetch;
  const config = configClickUpDesdeEnv(process.env);

  beforeAll(() => {
    if (!config) throw new Error('Falta CLICKUP_API_TOKEN');
    fetchOriginal = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
      const destino = new URL(input instanceof Request ? input.url : String(input));
      const metodo = (options?.method || 'GET').toUpperCase();
      if (destino.origin !== 'https://api.clickup.com' || metodo !== 'GET') throw new Error(`Solo lectura en ClickUp: bloqueado ${metodo} ${destino.origin}`);
      return fetchOriginal(input, options);
    };
  });

  afterAll(() => { if (fetchOriginal) globalThis.fetch = fetchOriginal; });

  it('la lista tiene los campos supuestos; muestra los nombres de los campos y las opciones de la etapa', async () => {
    const response = await fetch(`https://api.clickup.com/api/v2/list/${config!.lista}/field`, { headers: { Authorization: config!.token } });
    expect(response.status, 'Sin acceso a la lista: pide a Jean que la comparta con la cuenta del token').toBe(200);
    const { fields = [] } = await response.json() as { fields?: Array<{ name: string; type: string; type_config?: { options?: Array<{ name: string }> } }> };
    const etapa = fields.find((f) => f.name.toLowerCase() === config!.campoEtapa.toLowerCase());
    console.log(JSON.stringify({
      lista: config!.lista,
      campos: fields.map((f) => `${f.name} (${f.type})`),
      opciones_etapa: etapa?.type_config?.options?.map((o) => `${o.name} → ${faseDeEtapa(o.name) ?? '—'}`) ?? '(no hay campo de etapa)',
    }, null, 2));
    expect(fields.map((f) => f.name.toLowerCase()), `No existe el campo «${config!.campoEmail}»: configura REUNIONES_MEET_CLICKUP_CAMPO_EMAIL`).toContain(config!.campoEmail.toLowerCase());
    expect(etapa, `No existe el campo «${config!.campoEtapa}»: configura REUNIONES_MEET_CLICKUP_CAMPO_ETAPA`).toBeTruthy();
  }, 60_000);

  it('encuentra el lead del email de prueba (una sola tarea padre) y lee su etapa', async () => {
    const email = process.env.QA_CLICKUP_EMAIL_LEAD?.trim();
    if (!email) throw new Error('Falta QA_CLICKUP_EMAIL_LEAD (email de un lead que exista en la lista)');
    const leads = await crearBuscadorLeads(config)!([email.toLowerCase()]);
    console.log(JSON.stringify({ encontrados: leads.length, ids: leads.map((l) => l.id), etapas: leads.map((l) => `${l.etapa ?? '—'} → ${faseDeEtapa(l.etapa) ?? '—'}`) }, null, 2));
    expect(leads).toHaveLength(1);
  }, 60_000);

  it('un email que no existe no encuentra nada', async () => {
    expect(await crearBuscadorLeads(config)!(['no-existe-prueba-869fppbcj@example.com'])).toEqual([]);
  }, 60_000);
});
