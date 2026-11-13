// Cliente mínimo de ClickUp (API v2) para la captación ABCD: lee los leads de «Contacto de Reforma» y
// escribe la calificación en los únicos campos permitidos. No usa ninguna librería: solo `fetch`.
// El token solo viaja en la cabecera Authorization hacia la base indicada y nunca aparece en un error.
import { ETIQUETA_CATEGORIA, ETIQUETA_SIN_PRESUPUESTO, type Categoria } from './tipos.ts';
import type { EscriturasClickUp } from './motor.ts';
import type { LeadCandidato } from './vinculacion.ts';

export const CLICKUP_API = 'https://api.clickup.com/api/v2';

/** Nombres de los campos personalizados de la lista (se resuelven a su id con GET /list/{id}/field). */
export const NOMBRES_CAMPOS = {
  categoria: 'valoracion_interna',
  presupuesto: 'presupuesto_estimado',
  ponderado: 'valor_del_negocio',
  fuente_presupuesto: 'Fuente del presupuesto',
  desglose: 'Desglose de calificación',
  indice_orden: 'Índice de orden',
  telefono: 'contact_phone_number',
  email: 'email',
  etapa: 'ETAPA_CRM',
  tipo_reforma: 'tipo_reforma',
  tipo_contacto: 'Tipo de Contacto',
} as const;

/** El error no trae el token ni el cuerpo de la respuesta (puede contener datos de clientes). */
export class ClickUpError extends Error {
  constructor(message: string, readonly estado: number | null, readonly reintentable: boolean) {
    super(message);
    this.name = 'ClickUpError';
  }
}

/** La lista no tiene el campo o la opción que hay que escribir: no se escribe nada hasta que se cree. */
export class ClickUpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClickUpConfigError';
  }
}

export interface OpcionCampo {
  id: string;
  name: string;
  orderindex: number;
}

export interface CampoLista {
  id: string;
  name: string;
  type: string;
  opciones: OpcionCampo[];
}

export interface ClickUpConfig {
  token: string;
  listaId: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
  /** Pausa entre peticiones (ms) para no pasar de 100 por minuto. Por defecto 700. */
  pausaMs?: number;
  /** Para pruebas: sustituye a la espera real. */
  esperar?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxReintentos?: number;
}

export function clickupConfigDesdeEnv(env: NodeJS.ProcessEnv = process.env): ClickUpConfig | null {
  const token = env.CLICKUP_API_TOKEN?.trim();
  const listaId = env.CAPTACION_CLICKUP_LIST_ID?.trim();
  if (!token || !listaId) return null;
  return { token, listaId };
}

const dormir = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ClickUpClient {
  private ultimaPeticion = 0;
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly pausaMs: number;
  private readonly esperar: (ms: number) => Promise<void>;
  private readonly maxReintentos: number;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: ClickUpConfig) {
    if (!cfg.token) throw new Error('Falta el token de ClickUp');
    if (!/^\d+$/.test(cfg.listaId)) throw new Error('El id de la lista de ClickUp debe ser numérico');
    this.base = (cfg.baseUrl ?? CLICKUP_API).replace(/\/$/, '');
    this.fetcher = cfg.fetcher ?? fetch;
    this.pausaMs = cfg.pausaMs ?? 700;
    this.esperar = cfg.esperar ?? dormir;
    this.maxReintentos = cfg.maxReintentos ?? 4;
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
  }

  private async pedir(metodo: 'GET' | 'POST', ruta: string, cuerpo?: unknown): Promise<unknown> {
    for (let intento = 1; ; intento++) {
      const espera = this.ultimaPeticion + this.pausaMs - Date.now();
      if (espera > 0) await this.esperar(espera);
      this.ultimaPeticion = Date.now();
      let respuesta: Response;
      try {
        respuesta = await this.fetcher(`${this.base}${ruta}`, {
          method: metodo,
          headers: { Authorization: this.cfg.token, ...(cuerpo === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (intento <= this.maxReintentos) {
          await this.esperar(2 ** intento * 500);
          continue;
        }
        throw new ClickUpError(`sin respuesta de ClickUp: ${(error as Error).name}`, null, true);
      }
      if (respuesta.ok) return respuesta.json().catch(() => ({}));
      const reintentable = respuesta.status === 429 || respuesta.status >= 500;
      if (reintentable && intento <= this.maxReintentos) {
        const reset = Number(respuesta.headers.get('x-ratelimit-reset'));
        const hastaReset = respuesta.status === 429 && Number.isFinite(reset) && reset > 0 ? reset * 1000 - Date.now() : 0;
        await this.esperar(Math.min(Math.max(hastaReset, 2 ** intento * 1000), 60_000));
        continue;
      }
      throw new ClickUpError(`ClickUp respondió ${respuesta.status} en ${metodo} ${ruta.split('?')[0]}`, respuesta.status, reintentable);
    }
  }

  /** Campos personalizados de la lista, con sus opciones (para traducir nombres a ids). */
  async campos(): Promise<CampoLista[]> {
    const r = (await this.pedir('GET', `/list/${this.cfg.listaId}/field`)) as { fields?: Array<Record<string, any>> };
    return (r.fields ?? []).map((f) => ({
      id: String(f.id),
      name: String(f.name),
      type: String(f.type),
      opciones: Array.isArray(f.type_config?.options)
        ? f.type_config.options.map((o: Record<string, any>) => ({ id: String(o.id), name: String(o.name ?? o.label ?? ''), orderindex: Number(o.orderindex) }))
        : [],
    }));
  }

  /** Tareas padre de la lista (abiertas y cerradas, sin archivadas), página a página. Sin subtareas: no se vinculan. */
  async *tareas(): AsyncGenerator<TareaClickUp> {
    for (let pagina = 0; ; pagina++) {
      const r = (await this.pedir('GET', `/list/${this.cfg.listaId}/task?page=${pagina}&include_closed=true&subtasks=false&archived=false`)) as { tasks?: Array<Record<string, any>> };
      const tareas = r.tasks ?? [];
      for (const t of tareas) yield aTarea(t);
      if (tareas.length < 100) return;
    }
  }

  /** Una tarea concreta con sus campos actuales. */
  async tarea(id: string): Promise<TareaClickUp> {
    if (!/^[A-Za-z0-9]+$/.test(id)) throw new Error('Id de tarea no válido');
    return aTarea((await this.pedir('GET', `/task/${id}`)) as Record<string, any>);
  }

  /** Escribe el valor de UN campo personalizado de una tarea (POST /task/{id}/field/{campo}). */
  async escribirCampo(tareaId: string, campoId: string, valor: string | number): Promise<void> {
    if (!/^[A-Za-z0-9]+$/.test(tareaId)) throw new Error('Id de tarea no válido');
    if (!/^[A-Za-z0-9-]+$/.test(campoId)) throw new Error('Id de campo no válido');
    await this.pedir('POST', `/task/${tareaId}/field/${campoId}`, { value: valor });
  }
}

// ---------------------------------------------------------------------------------------------
// Tareas
// ---------------------------------------------------------------------------------------------

export interface TareaClickUp {
  id: string;
  nombre: string;
  esPadre: boolean;
  estado: string;
  cerrada: boolean;
  creadaEn: number;
  /** Valor de cada campo por su nombre: los desplegables ya traducidos al nombre de la opción. */
  campos: Record<string, string | number | null>;
}

function aTarea(t: Record<string, any>): TareaClickUp {
  const campos: Record<string, string | number | null> = {};
  for (const c of Array.isArray(t.custom_fields) ? (t.custom_fields as Array<Record<string, any>>) : []) {
    const v = c.value;
    if (v === undefined || v === null || v === '') {
      campos[String(c.name)] = null;
      continue;
    }
    if (c.type === 'drop_down') {
      const op = (c.type_config?.options ?? []).find((o: Record<string, any>) => o.orderindex === v || o.id === v);
      campos[String(c.name)] = op ? String(op.name ?? op.label ?? '') : String(v);
    } else if (typeof v === 'number') {
      campos[String(c.name)] = v;
    } else if (typeof v === 'string' && c.type === 'currency') {
      campos[String(c.name)] = Number(v);
    } else {
      campos[String(c.name)] = typeof v === 'string' ? v : JSON.stringify(v);
    }
  }
  return {
    id: String(t.id),
    nombre: String(t.name ?? ''),
    esPadre: !t.parent,
    estado: String(t.status?.status ?? ''),
    cerrada: t.status?.type === 'closed',
    creadaEn: Number(t.date_created) || 0,
    campos,
  };
}

const texto = (v: string | number | null | undefined): string | null => (v === null || v === undefined || v === '' ? null : String(v));

/** Tareas → candidatos para vincular una llamada (teléfono y email del lead; solo las padre cuentan). */
export function aLeadCandidato(t: TareaClickUp): LeadCandidato {
  return {
    clickupTaskId: t.id,
    esTareaPadre: t.esPadre,
    telefono: texto(t.campos[NOMBRES_CAMPOS.telefono]),
    email: texto(t.campos[NOMBRES_CAMPOS.email]),
  };
}

// ---------------------------------------------------------------------------------------------
// Plan de escritura
// ---------------------------------------------------------------------------------------------

/** Posición de cada categoría en el índice de orden: cuanto más alto, más potencial. */
export const RANGO_ORDEN: Record<Categoria, number> = { 'A+': 6, A: 5, B: 4, C: 3, D: 2, sin_calificar: 1, no_apto: 0 };

/** Las 8 cifras bajas del índice son el ponderado en euros; el rango de la categoría va por encima. */
export const ESCALA_ORDEN = 100_000_000;

/**
 * Número que permite ordenar el tablero de ClickUp (que no ordena por un desplegable): de MAYOR a menor queda primero A+,
 * y dentro de cada categoría el de más valor ponderado. Sin ponderado (o negativo) cuenta como 0; por encima de
 * 99.999.999 € se recorta para no pasar a la categoría de arriba.
 */
export function indiceOrdenDe(categoria: Categoria, ponderado: number | null): number {
  const euros = ponderado !== null && Number.isFinite(ponderado) && ponderado > 0 ? Math.min(Math.round(ponderado), ESCALA_ORDEN - 1) : 0;
  return RANGO_ORDEN[categoria] * ESCALA_ORDEN + euros;
}

export interface CambioCampo {
  /** Clave de las escrituras del motor (categoria, presupuesto…). */
  clave: keyof Omit<typeof NOMBRES_CAMPOS, 'telefono' | 'email' | 'etapa' | 'tipo_reforma' | 'tipo_contacto'>;
  campoId: string;
  valor: string | number;
}

export interface PlanEscritura {
  cambios: CambioCampo[];
  /** Escrituras que no se hacen: sin valor (presupuesto o ponderado nulos) o porque el campo opcional no existe. */
  omitidos: string[];
}

/**
 * Traduce las escrituras del motor a (campo, valor) de ClickUp. Valida TODO antes de devolver nada: si falta un
 * campo o una opción lanza `ClickUpConfigError` y no se escribe ni un campo de ese lead (nunca queda a medias).
 */
export function planEscritura(esc: EscriturasClickUp & { desglose?: string }, campos: readonly CampoLista[]): PlanEscritura {
  const porNombre = (nombre: string): CampoLista => {
    const c = campos.find((x) => x.name === nombre);
    if (!c) throw new ClickUpConfigError(`La lista no tiene el campo «${nombre}»`);
    return c;
  };
  const opcion = (campo: CampoLista, etiqueta: string): OpcionCampo => {
    const o = campo.opciones.find((x) => x.name === etiqueta);
    if (!o) throw new ClickUpConfigError(`El campo «${campo.name}» no tiene la opción «${etiqueta}»`);
    return o;
  };
  const cambios: CambioCampo[] = [];
  const omitidos: string[] = [];

  const cat = porNombre(NOMBRES_CAMPOS.categoria);
  cambios.push({ clave: 'categoria', campoId: cat.id, valor: opcion(cat, ETIQUETA_CATEGORIA[esc.categoria]).id });

  // «Fuente del presupuesto» es OPCIONAL: si la lista no tiene el campo se omite (y se anota). Si el campo existe pero le
  // falta la opción que toca, sí es un error de configuración.
  const fuente = campos.find((x) => x.name === NOMBRES_CAMPOS.fuente_presupuesto);
  if (fuente) {
    const etiquetaFuente = esc.fuente_presupuesto || ETIQUETA_SIN_PRESUPUESTO;
    cambios.push({ clave: 'fuente_presupuesto', campoId: fuente.id, valor: opcion(fuente, etiquetaFuente).id });
  } else {
    omitidos.push('fuente_presupuesto (el campo no existe en la lista)');
  }

  for (const clave of ['presupuesto', 'ponderado'] as const) {
    const valor = esc[clave];
    const campo = porNombre(NOMBRES_CAMPOS[clave]);
    if (valor === null) omitidos.push(`${clave} (sin valor)`);
    else if (!Number.isFinite(valor)) throw new ClickUpConfigError(`${clave} no es un número`);
    else cambios.push({ clave, campoId: campo.id, valor });
  }

  // «Índice de orden» es OPCIONAL, como la fuente: si la lista no tiene el campo se omite y se anota (el tablero «Por
  // potencial» no ordenaría, pero el resto de la calificación se escribe igual).
  const indice = campos.find((x) => x.name === NOMBRES_CAMPOS.indice_orden);
  if (indice) cambios.push({ clave: 'indice_orden', campoId: indice.id, valor: indiceOrdenDe(esc.categoria, esc.ponderado) });
  else omitidos.push('indice_orden (el campo no existe en la lista)');

  if (esc.desglose !== undefined) {
    const d = porNombre(NOMBRES_CAMPOS.desglose);
    cambios.push({ clave: 'desglose', campoId: d.id, valor: esc.desglose });
  }
  return { cambios, omitidos };
}

/** Un POST falló DESPUÉS de haber cambiado `camposEscritos` campos de la tarea: ClickUp conserva esos cambios. */
export class ClickUpEscrituraParcial extends Error {
  constructor(readonly camposEscritos: number, readonly camposTotal: number, readonly causa: Error) {
    super(`escritura parcial: ${camposEscritos} de ${camposTotal} campos (${causa.message})`);
    this.name = 'ClickUpEscrituraParcial';
  }
}

/**
 * Escribe un plan en una tarea, campo a campo. Devuelve cuántos campos escribió. Si falla el primero, relanza el
 * error tal cual (no se tocó nada); si falla uno posterior, lanza `ClickUpEscrituraParcial` con lo ya escrito.
 * Repetir el plan es seguro: cada POST fija el valor del campo.
 */
export async function escribirPlan(cliente: ClickUpClient, tareaId: string, plan: PlanEscritura): Promise<number> {
  let escritos = 0;
  for (const c of plan.cambios) {
    try {
      await cliente.escribirCampo(tareaId, c.campoId, c.valor);
    } catch (error) {
      if (escritos === 0) throw error;
      throw new ClickUpEscrituraParcial(escritos, plan.cambios.length, error as Error);
    }
    escritos += 1;
  }
  return escritos;
}
