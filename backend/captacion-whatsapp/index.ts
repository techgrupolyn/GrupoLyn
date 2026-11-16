// Captación · WhatsApp automático cuando un lead entra en «e1 EN ESPERA». Ver docs/CAPTACION_WHATSAPP_ESPERA.md.
//
//   ensureCaptacionWhatsApp(pool)          esquema aditivo (en ensureDatabaseSchema)
//   createCaptacionWhatsApp(pool, env)     receptores (router, antes de express.json) y procesos en segundo plano
//   registrarApiCaptacion(app, deps)       historial de avisos para el Dashboard
//
// Apagado por defecto: sin CAPTACION_WHATSAPP_ENABLED=true y CLICKUP_API_TOKEN, los receptores responden 404 y no
// arranca ningún proceso.
import type { Pool } from 'pg';
import { crearClienteClickUp, type ClienteClickUp } from './clickup.ts';
import { crearEnviador, type Enviar } from './cloud-api.ts';
import { configCaptacionDesdeEnv } from './config.ts';
import { barrer, procesarAvisos, procesarInbox } from './proceso.ts';
import { crearRouterWebhooks } from './rutas.ts';

export { ensureCaptacionWhatsApp } from './schema.ts';
export { registrarApiCaptacion } from './rutas.ts';

const INTERVALO_INBOX_MS = 5_000;
const INTERVALO_AVISOS_MS = 10_000;

function unaVez(nombre: string, tarea: () => Promise<unknown>): () => void {
  let enCurso = false;
  return () => {
    if (enCurso) return;
    enCurso = true;
    tarea().catch((error) => console.error(`[captacion] Error en ${nombre}:`, (error as Error).message)).finally(() => { enCurso = false; });
  };
}

export function createCaptacionWhatsApp(pool: Pool, env: NodeJS.ProcessEnv = process.env, deps: { clickup?: ClienteClickUp; enviar?: Enviar | null } = {}) {
  const config = configCaptacionDesdeEnv(env);
  const minutosBarrido = Number(env.CAPTACION_BARRIDO_MINUTOS || 5);
  const clickup = config ? deps.clickup ?? crearClienteClickUp(config.clickup) : null;
  const enviar = deps.enviar !== undefined ? deps.enviar : config?.cloud ? crearEnviador(config.cloud) : null;

  const avisos = unaVez('envío de avisos', async () => {
    if (!config) return;
    while ((await procesarAvisos(pool, config, enviar)) > 0) { /* siguiente lote */ }
  });
  const inbox = unaVez('bandeja de ClickUp', async () => {
    if (!clickup) return;
    while ((await procesarInbox(pool, clickup)) > 0) { /* siguiente lote */ }
    avisos();
  });
  const barrido = unaVez('barrido de leads en espera', async () => {
    if (!clickup) return;
    const r = await barrer(pool, clickup);
    if (r.nuevas || r.salidas || r.linea_base) console.log(JSON.stringify({ msg: 'captacion_barrido', ...r }));
    if (r.nuevas) avisos();
  });

  return {
    router: crearRouterWebhooks(pool, config, inbox),
    start() {
      if (!config) {
        if (env.CAPTACION_WHATSAPP_ENABLED === 'true') console.warn('[captacion] CAPTACION_WHATSAPP_ENABLED=true sin CLICKUP_API_TOKEN: el aviso por WhatsApp no arranca');
        return;
      }
      if (!config.cloud) console.warn('[captacion] Sin WHATSAPP_CLOUD_TOKEN / CAPTACION_WHATSAPP_PLANTILLA: los avisos se registran pero no se envían');
      for (const r of [config.remitentes.alto, config.remitentes.base]) {
        if (!r.numeroId) console.warn(`[captacion] ${r.nombre} sin número en la Cloud API (CAPTACION_WHATSAPP_REMITENTE_${r.clave.toUpperCase()}_NUMERO_ID): sus avisos esperan`);
      }
      if (config.soloTelefonos) console.warn(`[captacion] MODO QA: solo se escribe a ${config.soloTelefonos.length} teléfono(s) de CAPTACION_WHATSAPP_SOLO_TELEFONOS`);
      if (!config.clickup.webhookSecret) console.warn('[captacion] Sin CAPTACION_CLICKUP_WEBHOOK_SECRET: solo el barrido detecta las entradas en e1');
      if (config.cloud && !config.cloud.appSecret) console.warn('[captacion] Sin WHATSAPP_CLOUD_APP_SECRET: no se reciben los estados de entrega');
      if (!Number.isFinite(minutosBarrido) || minutosBarrido < 1) throw new Error('CAPTACION_BARRIDO_MINUTOS debe ser >= 1');
      for (const [tarea, ms] of [[inbox, INTERVALO_INBOX_MS], [avisos, INTERVALO_AVISOS_MS], [barrido, minutosBarrido * 60_000]] as const) {
        tarea();
        setInterval(tarea, ms).unref();
      }
    },
  };
}
