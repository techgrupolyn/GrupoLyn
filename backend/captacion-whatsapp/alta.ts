// Altas manuales del aviso de Captación (las ejecuta una persona, una vez; el backend nunca las llama):
//
//   npx tsx captacion-whatsapp/alta.ts plantilla           crea la plantilla en Meta y la envía a aprobación
//   npx tsx captacion-whatsapp/alta.ts estado-plantilla    muestra si Meta ya la aprobó
//   npx tsx captacion-whatsapp/alta.ts webhook-clickup URL  da de alta el webhook de ClickUp para la lista
//   npx tsx captacion-whatsapp/alta.ts prueba-envio +34600000000 [plantilla] [idioma]
//        envía UNA plantilla a ese móvil con el mismo código que usa el backend (por defecto hello_world / en_US,
//        la de prueba de Meta) desde WHATSAPP_CLOUD_PHONE_NUMBER_ID. Solo a un móvil propio del equipo.
//
// Variables: WHATSAPP_CLOUD_TOKEN, WHATSAPP_CLOUD_WABA_ID, CAPTACION_WHATSAPP_PLANTILLA, CAPTACION_WHATSAPP_IDIOMA
// (Meta); CLICKUP_API_TOKEN, CLICKUP_TEAM_ID, CAPTACION_CLICKUP_LISTA (ClickUp). Ver docs/CAPTACION_WHATSAPP_ESPERA.md.
import 'dotenv/config';
import { LISTA_CONTACTO_REFORMA } from '../reuniones-meet/clickup.ts';
import { crearEnviador, type ErrorCloud } from './cloud-api.ts';

/** Texto de Alex (12/11/2026). Sin variables: la plantilla no lleva datos del lead. */
export const TEXTO_PLANTILLA = 'Hola, hemos recibido tu solicitud de llamada. Un asesor te llamará en breve.';

const requerida = (nombre: string) => {
  const valor = process.env[nombre]?.trim();
  if (!valor) throw new Error(`Falta ${nombre}`);
  return valor;
};
const graph = (ruta: string) => `https://graph.facebook.com/${process.env.WHATSAPP_CLOUD_API_VERSION?.trim() || 'v23.0'}${ruta}`;

async function mostrar(response: Response) {
  const cuerpo = await response.text();
  console.log(`HTTP ${response.status}`);
  console.log(cuerpo);
  if (!response.ok) process.exitCode = 1;
}

async function main() {
  const [comando, argumento] = process.argv.slice(2);
  if (comando === 'plantilla') {
    // UTILITY: responde a una solicitud del propio lead (no es publicidad). Meta puede recategorizarla.
    await mostrar(await fetch(graph(`/${requerida('WHATSAPP_CLOUD_WABA_ID')}/message_templates`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${requerida('WHATSAPP_CLOUD_TOKEN')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: requerida('CAPTACION_WHATSAPP_PLANTILLA'),
        language: process.env.CAPTACION_WHATSAPP_IDIOMA?.trim() || 'es_ES',
        category: 'UTILITY',
        components: [{ type: 'BODY', text: TEXTO_PLANTILLA }],
      }),
    }));
  } else if (comando === 'estado-plantilla') {
    const params = new URLSearchParams({ name: requerida('CAPTACION_WHATSAPP_PLANTILLA'), fields: 'name,language,status,category,rejected_reason' });
    await mostrar(await fetch(graph(`/${requerida('WHATSAPP_CLOUD_WABA_ID')}/message_templates?${params}`), {
      headers: { Authorization: `Bearer ${requerida('WHATSAPP_CLOUD_TOKEN')}` },
    }));
  } else if (comando === 'webhook-clickup') {
    if (!argumento?.startsWith('https://')) throw new Error('Uso: webhook-clickup https://<dominio>/webhook/captacion/clickup');
    // La respuesta trae webhook.secret: guárdalo en CAPTACION_CLICKUP_WEBHOOK_SECRET.
    await mostrar(await fetch(`https://api.clickup.com/api/v2/team/${encodeURIComponent(requerida('CLICKUP_TEAM_ID'))}/webhook`, {
      method: 'POST',
      headers: { Authorization: requerida('CLICKUP_API_TOKEN'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: argumento, events: ['taskCreated', 'taskUpdated'], list_id: Number(process.env.CAPTACION_CLICKUP_LISTA?.trim() || LISTA_CONTACTO_REFORMA) }),
    }));
  } else if (comando === 'prueba-envio') {
    const [plantilla = 'hello_world', idioma = 'en_US'] = process.argv.slice(4);   // node, script, comando, teléfono, …
    const telefono = String(argumento || '').replace(/[\s\-().]/g, '');
    if (!/^\+\d{8,15}$/.test(telefono)) throw new Error(`Teléfono no válido: «${argumento ?? ''}». Uso: prueba-envio +34600000000 [plantilla] [idioma] (con + y prefijo de país; entre comillas si lleva espacios)`);
    const enviar = crearEnviador({
      token: requerida('WHATSAPP_CLOUD_TOKEN'),
      versionApi: process.env.WHATSAPP_CLOUD_API_VERSION?.trim() || 'v23.0',
      plantilla,
      idioma,
      appSecret: null,
      verifyToken: null,
    });
    try {
      const { wamid } = await enviar(telefono, requerida('WHATSAPP_CLOUD_PHONE_NUMBER_ID'));
      console.log(`Enviado: plantilla ${plantilla} (${idioma}) · wamid ${wamid}`);
    } catch (error) {
      const e = error as ErrorCloud;
      console.error(`No enviado: ${e.message}${e.reintentable ? ' (el backend lo reintentaría)' : ' (el backend lo dejaría fallido)'}`);
      process.exitCode = 1;
    }
  } else {
    console.log('Comandos: plantilla | estado-plantilla | webhook-clickup <url> | prueba-envio <+telefono> [plantilla] [idioma]');
    process.exitCode = 1;
  }
}

main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
