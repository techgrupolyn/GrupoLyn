// Búsqueda del lead de una reunión en la lista de ClickUp «Contacto de Reforma» (869fppbcj, bloque B). Solo lectura.
//
// El lead es la tarea padre de la lista (las subtareas heredadas, como «Llamada 1ª», no cuentan). Se busca por el email
// de los invitados externos contra el campo personalizado de email, y se devuelve su etapa (ETAPA_CRM) para la fase.
// Nombres tomados del ticket (sin acceso a la lista para comprobarlos): campo `email`, `contact_phone_number` y
// `ETAPA_CRM`; lista 901211441576. Todos se cambian por variables de entorno sin tocar el código.
//
//   CLICKUP_API_TOKEN                        token de la API (si falta, no se busca: los leads quedan «pendiente»)
//   REUNIONES_MEET_CLICKUP_LISTA             id de la lista (por defecto 901211441576)
//   REUNIONES_MEET_CLICKUP_CAMPO_EMAIL       nombre del campo de email (por defecto «email»)
//   REUNIONES_MEET_CLICKUP_CAMPO_ETAPA       nombre del campo de etapa (por defecto «ETAPA_CRM»)
import type { BuscarLead } from './lead.ts';

const API = 'https://api.clickup.com/api/v2';
export const LISTA_CONTACTO_REFORMA = '901211441576';

export type ConfigClickUp = { token: string; lista: string; campoEmail: string; campoEtapa: string };

export function configClickUpDesdeEnv(env: NodeJS.ProcessEnv = process.env): ConfigClickUp | null {
  const token = env.CLICKUP_API_TOKEN?.trim();
  if (!token) return null;
  return {
    token,
    lista: env.REUNIONES_MEET_CLICKUP_LISTA?.trim() || LISTA_CONTACTO_REFORMA,
    campoEmail: env.REUNIONES_MEET_CLICKUP_CAMPO_EMAIL?.trim() || 'email',
    campoEtapa: env.REUNIONES_MEET_CLICKUP_CAMPO_ETAPA?.trim() || 'ETAPA_CRM',
  };
}

type Opcion = { id?: string; name?: string; orderindex?: number | string };
type Campo = { id: string; name: string; type?: string; type_config?: { options?: Opcion[] }; value?: unknown };
type Tarea = { id: string; parent?: string | null; custom_fields?: Campo[] };

export class ErrorClickUp extends Error {
  constructor(message: string, readonly status: number | null) { super(message); }
}

const mismoNombre = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Nombre de la opción elegida en un desplegable de ClickUp: el valor llega como orderindex (número) o como id. */
export function valorDesplegable(campo: Campo | undefined, opciones: Opcion[] = []): string | null {
  if (!campo || campo.value === null || campo.value === undefined || campo.value === '') return null;
  const lista = campo.type_config?.options?.length ? campo.type_config.options : opciones;
  const v = String(campo.value);
  const opcion = lista.find((o) => String(o.orderindex) === v || String(o.id) === v);
  return opcion?.name ?? (typeof campo.value === 'string' ? campo.value : null);
}

/** Crea la búsqueda de leads contra ClickUp, o null si no hay token (entonces los leads se quedan «pendiente»). */
export function crearBuscadorLeads(config: ConfigClickUp | null, fetcher: typeof fetch = fetch): BuscarLead | null {
  if (!config) return null;
  const pedir = async <T>(ruta: string): Promise<T> => {
    const response = await fetcher(`${API}${ruta}`, { headers: { Authorization: config.token }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new ErrorClickUp(`ClickUp respondió ${response.status} en ${ruta.split('?')[0]}`, response.status);
    return await response.json() as T;
  };
  // Los ids de los campos se piden una vez y se guardan; si falla, se vuelve a pedir la próxima vez.
  let campos: Promise<{ email: Campo; etapa: Campo | null }> | null = null;
  const camposDeLaLista = () => {
    campos ??= pedir<{ fields?: Campo[] }>(`/list/${encodeURIComponent(config.lista)}/field`).then(({ fields = [] }) => {
      const email = fields.find((f) => mismoNombre(f.name, config.campoEmail));
      if (!email) throw new ErrorClickUp(`La lista no tiene el campo «${config.campoEmail}»`, null);
      return { email, etapa: fields.find((f) => mismoNombre(f.name, config.campoEtapa)) ?? null };
    }).catch((error) => { campos = null; throw error; });
    return campos;
  };

  return async (emails) => {
    const { email: campoEmail, etapa: campoEtapa } = await camposDeLaLista();
    const encontrados = new Map<string, { id: string; etapa: string | null }>();
    for (const buscado of emails) {
      const filtro = JSON.stringify([{ field_id: campoEmail.id, operator: '=', value: buscado }]);
      const params = new URLSearchParams({ include_closed: 'true', subtasks: 'false', custom_fields: filtro });
      const { tasks = [] } = await pedir<{ tasks?: Tarea[] }>(`/list/${encodeURIComponent(config.lista)}/task?${params}`);
      for (const t of tasks) {
        if (t.parent) continue;   // solo tareas padre
        // Comprobación local (sin mayúsculas ni espacios): el filtro de ClickUp puede ser exacto o aproximado.
        const valor = String(t.custom_fields?.find((c) => c.id === campoEmail.id)?.value ?? '').trim().toLowerCase();
        if (valor !== buscado.trim().toLowerCase()) continue;
        const etapa = campoEtapa ? valorDesplegable(t.custom_fields?.find((c) => c.id === campoEtapa.id), campoEtapa.type_config?.options) : null;
        encontrados.set(t.id, { id: t.id, etapa });
      }
    }
    return [...encontrados.values()];
  };
}
