// ClickUp para el aviso de Captación: firma y lectura de los webhooks, y consultas de solo lectura a la lista
// «Contacto de Reforma» (tarea, campos y leads que están ahora en e1). Nunca escribe en ClickUp.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ErrorClickUp } from '../reuniones-meet/clickup.ts';
import type { ConfigCaptacion } from './config.ts';

export { ErrorClickUp };

const API = 'https://api.clickup.com/api/v2';

export type Opcion = { id?: string; name?: string; orderindex?: number | string };
export type Campo = { id: string; name: string; type?: string; type_config?: { options?: Opcion[] }; value?: unknown };
export type Tarea = { id: string; name?: string; parent?: string | null; list?: { id?: string }; custom_fields?: Campo[]; date_updated?: string };

/** Lead tal como lo necesita el aviso. */
export type Lead = { taskId: string; nombre: string | null; telefono: string | null; etapa: string | null };

const mismoNombre = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** ClickUp firma el cuerpo crudo con HMAC-SHA256 (hex) del secreto del webhook, en la cabecera X-Signature. */
export function firmaClickUpValida(cuerpo: Buffer, firma: string | undefined, secreto: string): boolean {
  if (!firma) return false;
  const esperada = createHmac('sha256', secreto).update(cuerpo).digest();
  const recibida = Buffer.from(firma.trim(), 'hex');
  return recibida.length === esperada.length && timingSafeEqual(recibida, esperada);
}

/** Nombre de la opción de un desplegable. ClickUp da el valor como id, como orderindex o como objeto. */
export function nombreOpcion(valor: unknown, opciones: Opcion[] = []): string | null {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'object') {
    const o = valor as Opcion;
    if (o.name) return o.name;
    return nombreOpcion(o.id ?? o.orderindex, opciones);
  }
  const v = String(valor);
  const opcion = opciones.find((o) => String(o.id) === v || String(o.orderindex) === v);
  return opcion?.name ?? (typeof valor === 'string' && !/^[0-9a-f-]{36}$/i.test(valor) ? valor : null);
}

export type CambioEtapa = { historyId: string; fecha: Date; entra: boolean; sale: boolean };

type HistoryItem = { id?: string; date?: string | number; field?: string; before?: unknown; after?: unknown; custom_field?: Partial<Campo> };
export type WebhookClickUp = { event?: string; task_id?: string; webhook_id?: string; history_items?: HistoryItem[] };

/**
 * Cambios de ETAPA_CRM de un webhook taskUpdated: si el lead entra en e1 (antes otra etapa, ahora e1) o sale.
 * Los demás cambios de la tarea no cuentan.
 */
export function cambiosDeEtapa(payload: WebhookClickUp, campoEtapa: Campo, etapaEspera: string): CambioEtapa[] {
  const opciones = campoEtapa.type_config?.options ?? [];
  const cambios: CambioEtapa[] = [];
  for (const item of payload.history_items ?? []) {
    const cf = item.custom_field;
    const esEtapa = (cf && (cf.id === campoEtapa.id || (cf.name && mismoNombre(cf.name, campoEtapa.name)))) || item.field === campoEtapa.id;
    if (!esEtapa || !item.id) continue;
    const opcionesItem = cf?.type_config?.options?.length ? cf.type_config.options : opciones;
    const antes = nombreOpcion(item.before, opcionesItem);
    const despues = nombreOpcion(item.after, opcionesItem);
    const enEsperaAntes = antes !== null && mismoNombre(antes, etapaEspera);
    const enEsperaDespues = despues !== null && mismoNombre(despues, etapaEspera);
    if (enEsperaAntes === enEsperaDespues) continue;
    const fecha = new Date(Number(item.date));
    cambios.push({ historyId: String(item.id), fecha: Number.isFinite(fecha.getTime()) ? fecha : new Date(), entra: enEsperaDespues, sale: enEsperaAntes });
  }
  return cambios;
}

export type ClienteClickUp = {
  /** Nombre de la etapa de espera («e1 EN ESPERA»). */
  etapaEspera: string;
  campos(): Promise<{ etapa: Campo; telefono: Campo | null }>;
  tarea(taskId: string): Promise<Tarea | null>;
  /** Tareas padre de la lista que están ahora en e1 (todas las páginas). */
  enEspera(): Promise<Tarea[]>;
  lead(tarea: Tarea): Promise<Lead>;
  esDeLaLista(tarea: Tarea): boolean;
};

export function crearClienteClickUp(config: ConfigCaptacion['clickup'], fetcher: typeof fetch = fetch): ClienteClickUp {
  const pedir = async <T>(ruta: string): Promise<T | null> => {
    const response = await fetcher(`${API}${ruta}`, { headers: { Authorization: config.token }, signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new ErrorClickUp(`ClickUp respondió ${response.status} en ${ruta.split('?')[0]}`, response.status);
    return await response.json() as T;
  };
  let campos: Promise<{ etapa: Campo; telefono: Campo | null }> | null = null;
  const leerCampos = () => {
    campos ??= pedir<{ fields?: Campo[] }>(`/list/${encodeURIComponent(config.lista)}/field`).then((r) => {
      const fields = r?.fields ?? [];
      const etapa = fields.find((f) => mismoNombre(f.name, config.campoEtapa));
      if (!etapa) throw new ErrorClickUp(`La lista no tiene el campo «${config.campoEtapa}»`, null);
      return { etapa, telefono: fields.find((f) => mismoNombre(f.name, config.campoTelefono)) ?? null };
    }).catch((error) => { campos = null; throw error; });
    return campos;
  };
  const etapaDe = (tarea: Tarea, etapa: Campo) =>
    nombreOpcion(tarea.custom_fields?.find((c) => c.id === etapa.id)?.value, etapa.type_config?.options);

  return {
    etapaEspera: config.etapaEspera,
    campos: leerCampos,
    tarea: (taskId) => pedir<Tarea>(`/task/${encodeURIComponent(taskId)}`),
    esDeLaLista: (tarea) => !tarea.list?.id || String(tarea.list.id) === config.lista,
    async lead(tarea) {
      const { etapa, telefono } = await leerCampos();
      const valorTelefono = telefono ? tarea.custom_fields?.find((c) => c.id === telefono.id)?.value : undefined;
      return {
        taskId: tarea.id,
        nombre: tarea.name?.trim() || null,
        telefono: valorTelefono === null || valorTelefono === undefined || valorTelefono === '' ? null : String(valorTelefono),
        etapa: etapaDe(tarea, etapa),
      };
    },
    async enEspera() {
      const { etapa } = await leerCampos();
      const opcion = (etapa.type_config?.options ?? []).find((o) => o.name && mismoNombre(o.name, config.etapaEspera));
      if (!opcion?.id) throw new ErrorClickUp(`El campo «${config.campoEtapa}» no tiene la opción «${config.etapaEspera}»`, null);
      const filtro = JSON.stringify([{ field_id: etapa.id, operator: '=', value: opcion.id }]);
      const resultado: Tarea[] = [];
      for (let page = 0; page < 50; page++) {
        const params = new URLSearchParams({ subtasks: 'false', include_closed: 'false', page: String(page), custom_fields: filtro });
        const r = await pedir<{ tasks?: Tarea[]; last_page?: boolean }>(`/list/${encodeURIComponent(config.lista)}/task?${params}`);
        const tasks = r?.tasks ?? [];
        // Comprobación local: el filtro de ClickUp manda, pero solo cuentan las tareas padre que de verdad están en e1.
        for (const t of tasks) if (!t.parent && mismoNombre(etapaDe(t, etapa) ?? '', config.etapaEspera)) resultado.push(t);
        if (r?.last_page !== false || tasks.length === 0) return resultado;
      }
      throw new ErrorClickUp('Demasiadas páginas de leads en espera (más de 50)', null);
    },
  };
}
