// Webhook de ClickUp `taskUpdated` sobre «Contacto de Reforma» (captación ABCD, N-1.1 punto 5).
// Cuando un comercial cambia a mano la Categoría, el Presupuesto o el motivo de No continuidad de una tarjeta, esto lo
// registra (fuente «manual»), recalcula la calificación y deja en ClickUp los campos que escribe el sistema. Los avisos
// que provoca el propio usuario de integración y los de subtareas se descartan.
//
// ClickUp no normaliza los valores de los campos personalizados dentro del aviso, así que el aviso solo dice QUÉ campo
// tocó y QUIÉN; el valor se lee de la tarea. Reconciliar es idempotente: repetir un aviso no duplica nada ni vuelve a
// escribir lo que ya está bien (por eso un aviso reenviado o fuera de orden es inofensivo).
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  escribirPlan, indiceOrdenDe, NOMBRES_CAMPOS,
  planEscritura, type CampoLista, type ClickUpClient, type PlanEscritura, type TareaClickUp,
} from './clickup.ts';
import { decidirWebhook, type EscriturasConTextos, type EstadoPrevio } from './motor.ts';
import {
  bloquearLead, cargarEstado, categoriaAntesDeNoApto, enTransaccion, recalcularLead, registrarNoAptoManual, registrarPresupuestoManual,
  type Db, type ResultadoRecalculo,
} from './repositorio.ts';
import { CATEGORIAS, ETIQUETA_CATEGORIA, MOTIVO_NO_CONTINUIDAD_PRESUPUESTO, type Categoria } from './tipos.ts';

// ---------------------------------------------------------------------------------------------
// Firma y lectura del aviso
// ---------------------------------------------------------------------------------------------

/** `X-Signature` es el HMAC-SHA256 (hex) del cuerpo EXACTO que envió ClickUp, con el secreto del webhook. */
export function firmaValida(cuerpo: Buffer, firma: string | undefined, secreto: string): boolean {
  if (!secreto || !firma) return false;
  const esperada = createHmac('sha256', secreto).update(cuerpo).digest();
  const recibida = Buffer.from(firma.trim(), 'hex');
  return recibida.length === esperada.length && timingSafeEqual(recibida, esperada);
}

export interface ItemHistorial {
  id?: string;
  field?: string;
  date?: string | number;
  user?: { id?: number | string } | null;
  [clave: string]: unknown;
}

export interface EventoClickUp {
  evento: string;
  tareaId: string;
  items: ItemHistorial[];
}

/** Null si el cuerpo no es un aviso de ClickUp con un id de tarea válido. */
export function leerEvento(cuerpo: Buffer): EventoClickUp | null {
  let json: unknown;
  try {
    json = JSON.parse(cuerpo.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  if (typeof o.event !== 'string' || typeof o.task_id !== 'string' || !/^[A-Za-z0-9]+$/.test(o.task_id)) return null;
  const items = Array.isArray(o.history_items)
    ? o.history_items.filter((i): i is ItemHistorial => typeof i === 'object' && i !== null && !Array.isArray(i))
    : [];
  return { evento: o.event, tareaId: o.task_id, items };
}

// ---------------------------------------------------------------------------------------------
// Qué campo tocó un cambio
// ---------------------------------------------------------------------------------------------

export type CampoVigilado = 'categoria' | 'presupuesto' | 'no_continuidad' | 'sistema';
export type Tocados = Record<CampoVigilado, boolean>;

const NINGUNO: Tocados = { categoria: false, presupuesto: false, no_continuidad: false, sistema: false };
const TODOS: Tocados = { categoria: true, presupuesto: true, no_continuidad: true, sistema: true };

/** Campos que solo escribe el sistema: si alguien los edita, se restituyen. */
const NOMBRES_DEL_SISTEMA = [NOMBRES_CAMPOS.ponderado, NOMBRES_CAMPOS.fuente_presupuesto, NOMBRES_CAMPOS.indice_orden, NOMBRES_CAMPOS.desglose, NOMBRES_CAMPOS.resumen];

/**
 * Campos vigilados que toca un cambio del historial. Un cambio de estado, responsable, etc. no toca ninguno. Un cambio de un
 * campo personalizado se identifica por su id o su nombre dentro del aviso; si el aviso no dice qué campo fue (no se pudo
 * confirmar el formato real de ClickUp), se da por tocado cualquiera de los vigilados y la comparación con el estado
 * guardado decide si hay algo que registrar.
 */
export function camposTocados(item: ItemHistorial, campos: readonly CampoLista[]): Tocados {
  if (typeof item.field === 'string' && item.field !== 'custom_field') return { ...NINGUNO };
  const { user: _usuario, ...resto } = item;
  const texto = JSON.stringify(resto);
  const menciona = (nombre: string): boolean => {
    const id = campos.find((c) => c.name === nombre)?.id;
    return texto.includes(nombre) || (id !== undefined && texto.includes(id));
  };
  const tocados: Tocados = {
    categoria: menciona(NOMBRES_CAMPOS.categoria),
    presupuesto: menciona(NOMBRES_CAMPOS.presupuesto),
    no_continuidad: menciona(NOMBRES_CAMPOS.no_continuidad),
    sistema: NOMBRES_DEL_SISTEMA.some(menciona),
  };
  if (Object.values(tocados).some(Boolean)) return tocados;
  // Un campo personalizado sin identificar: solo se asume vigilado si el aviso no nombra NINGÚN campo conocido de la lista.
  const otroCampo = campos.some((c) => texto.includes(c.name) || texto.includes(c.id));
  return item.field === 'custom_field' && !otroCampo ? { ...TODOS } : { ...NINGUNO };
}

export const unirTocados = (a: Tocados, b: Tocados): Tocados => ({
  categoria: a.categoria || b.categoria,
  presupuesto: a.presupuesto || b.presupuesto,
  no_continuidad: a.no_continuidad || b.no_continuidad,
  sistema: a.sistema || b.sistema,
});

// ---------------------------------------------------------------------------------------------
// Lo que dice ClickUp y qué hay que registrar
// ---------------------------------------------------------------------------------------------

export interface LecturaClickUp {
  categoria: Categoria | null;
  presupuesto: number | null;
  noContinuidad: string | null;
}

const aNumero = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function leerCampos(t: TareaClickUp): LecturaClickUp {
  const etiqueta = t.campos[NOMBRES_CAMPOS.categoria];
  const categoria = CATEGORIAS.find((c) => ETIQUETA_CATEGORIA[c] === (typeof etiqueta === 'string' ? etiqueta.trim() : null)) ?? null;
  const presupuesto = aNumero(t.campos[NOMBRES_CAMPOS.presupuesto]);
  const motivo = t.campos[NOMBRES_CAMPOS.no_continuidad];
  return {
    categoria,
    presupuesto: presupuesto !== null && presupuesto > 0 ? presupuesto : null,
    noContinuidad: typeof motivo === 'string' && motivo.trim() !== '' ? motivo.trim() : null,
  };
}

export interface AccionesManuales {
  /** Importe nuevo que un comercial escribió en «Presupuesto». */
  presupuesto: number | null;
  /** true = marcar No apto a mano, false = quitarlo, null = sin cambio. */
  noApto: boolean | null;
  /** Categoría que eligió el comercial (o la que corresponde al motivo de No continuidad). */
  categoria: Categoria | null;
}

/**
 * Qué cambio manual hay que registrar. Solo cuenta un campo que el aviso dice haber tocado un humano Y cuyo valor en ClickUp
 * ya no coincide con lo último que calculó el sistema: si una escritura del sistema falló y ClickUp se quedó con el valor
 * viejo, eso NO se confunde con un cambio manual (se restituye al reescribir).
 * - Un importe vacío o 0 no se registra (no es un presupuesto): el campo se restituye.
 * - Categoría vacía tampoco: el sistema la restituye.
 * - «No continuidad = Presupuesto insuficiente» equivale a marcar No apto y manda sobre la categoría que se elija mientras
 *   siga puesto. Si el motivo deja de serlo y el No apto venía de una marca manual (no de la matriz), vuelve la categoría que
 *   el lead tenía antes.
 */
export function accionesManuales(e: {
  tocados: Tocados;
  ck: LecturaClickUp;
  previo: EstadoPrevio | null;
  categoriaPorMatriz: boolean;
  categoriaAntesDeNoApto: Categoria;
}): AccionesManuales {
  const { tocados, ck, previo } = e;
  const categoriaPrevia = previo?.categoria ?? null;
  let presupuesto: number | null = null;
  let noApto: boolean | null = null;
  let categoria: Categoria | null = null;

  if (tocados.presupuesto && ck.presupuesto !== null && Math.round(ck.presupuesto) !== (previo?.presupuestoVigente ?? null)) {
    presupuesto = Math.round(ck.presupuesto);
  }
  if (ck.noContinuidad === MOTIVO_NO_CONTINUIDAD_PRESUPUESTO) {
    // Mientras el motivo sea «Presupuesto insuficiente» el lead es No apto, elija lo que elija el comercial en la categoría
    // (No apto manda sobre todo). Si ya lo es, no hay nada que registrar y el sistema restituye la categoría en ClickUp.
    if ((tocados.no_continuidad || tocados.categoria) && categoriaPrevia !== 'no_apto') {
      noApto = true;
      categoria = 'no_apto';
    }
  } else {
    if (tocados.no_continuidad && categoriaPrevia === 'no_apto' && !e.categoriaPorMatriz) {
      noApto = false;
      categoria = e.categoriaAntesDeNoApto;
    }
    if (tocados.categoria && ck.categoria !== null && ck.categoria !== categoriaPrevia) {
      categoria = ck.categoria;
      noApto = ck.categoria === 'no_apto' ? true : categoriaPrevia === 'no_apto' ? false : null;
    }
  }
  return { presupuesto, noApto, categoria };
}

/**
 * De todo lo que escribe el sistema, lo que NO coincide con la tarea (para no reescribir lo que ya está bien y no
 * provocar avisos de más). Compara categoría, fuente y desglose por su texto y los importes como números.
 */
export function camposDesactualizados(esc: EscriturasConTextos, t: TareaClickUp): Set<PlanEscritura['cambios'][number]['clave']> {
  const desactualizados = new Set<PlanEscritura['cambios'][number]['clave']>();
  const texto = (nombre: string): string | null => {
    const v = t.campos[nombre];
    return v === null || v === undefined ? null : String(v).trim();
  };
  const numero = (nombre: string): number | null => aNumero(t.campos[nombre]);
  if (texto(NOMBRES_CAMPOS.categoria) !== ETIQUETA_CATEGORIA[esc.categoria]) desactualizados.add('categoria');
  if (numero(NOMBRES_CAMPOS.presupuesto) !== esc.presupuesto) desactualizados.add('presupuesto');
  if (numero(NOMBRES_CAMPOS.ponderado) !== esc.ponderado) desactualizados.add('ponderado');
  if (texto(NOMBRES_CAMPOS.fuente_presupuesto) !== esc.fuente_presupuesto) desactualizados.add('fuente_presupuesto');
  if (numero(NOMBRES_CAMPOS.indice_orden) !== indiceOrdenDe(esc.categoria, esc.ponderado)) desactualizados.add('indice_orden');
  if (esc.desglose !== undefined && texto(NOMBRES_CAMPOS.desglose) !== esc.desglose.trim()) desactualizados.add('desglose');
  if (esc.resumen !== undefined && texto(NOMBRES_CAMPOS.resumen) !== esc.resumen.trim()) desactualizados.add('resumen');
  return desactualizados;
}

// ---------------------------------------------------------------------------------------------
// Procesar un aviso
// ---------------------------------------------------------------------------------------------

export type ResultadoEvento =
  | { estado: 'ignorado'; motivo: 'evento_no_soportado' | 'sin_cambios' | 'escritura_del_sistema' | 'campo_no_vigilado' | 'subtarea' | 'lead_sin_calificar' }
  | { estado: 'procesado'; registrado: string[]; camposEscritos: number; omitidos: string[] };

export interface Conexion extends Db {
  release?: () => void;
}

export interface DependenciasWebhook {
  /** Una conexión propia (cliente de pg): la calificación de un aviso se guarda en una sola transacción. */
  conexion: () => Promise<Conexion>;
  clickup: Pick<ClickUpClient, 'tarea' | 'campos' | 'escribirCampo' | 'usuarioActual'>;
  /** Para pruebas y para fijarlo sin consultar a ClickUp. Por defecto, el dueño del token. */
  usuarioIntegracionId?: string;
  ahora?: () => Date;
  /** Cuánto se recuerdan los campos de la lista (ms). Por defecto 10 minutos. */
  ttlCamposMs?: number;
}

const aIso = (v: string | number | undefined, respaldo: Date): string => {
  const ms = Number(v);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : respaldo.toISOString();
};

export class ProcesadorWebhook {
  private usuario: string | null;
  private campos: { en: number; valor: CampoLista[] } | null = null;
  private readonly colas = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: DependenciasWebhook) {
    this.usuario = deps.usuarioIntegracionId ?? null;
  }

  private async usuarioIntegracion(): Promise<string> {
    if (this.usuario === null) this.usuario = await this.deps.clickup.usuarioActual();
    return this.usuario;
  }

  private async camposLista(): Promise<CampoLista[]> {
    const ahora = (this.deps.ahora ?? (() => new Date()))().getTime();
    if (!this.campos || ahora - this.campos.en > (this.deps.ttlCamposMs ?? 600_000)) {
      this.campos = { en: ahora, valor: await this.deps.clickup.campos() };
    }
    return this.campos.valor;
  }

  /** Tareas con avisos pendientes (para comprobar que la cola se vacía y no crece sin límite). */
  get enCurso(): number {
    return this.colas.size;
  }

  /** Los avisos de una misma tarea se atienden de uno en uno y en orden de llegada; los de tareas distintas, en paralelo. */
  encolar(evento: EventoClickUp): Promise<ResultadoEvento> {
    const previa = this.colas.get(evento.tareaId) ?? Promise.resolve();
    const actual = previa.catch(() => undefined).then(() => this.procesar(evento));
    this.colas.set(evento.tareaId, actual);
    const limpiar = (): void => {
      if (this.colas.get(evento.tareaId) === actual) this.colas.delete(evento.tareaId);
    };
    actual.then(limpiar, limpiar);
    return actual;
  }

  async procesar(evento: EventoClickUp): Promise<ResultadoEvento> {
    if (evento.evento !== 'taskUpdated') return { estado: 'ignorado', motivo: 'evento_no_soportado' };
    if (evento.items.length === 0) return { estado: 'ignorado', motivo: 'sin_cambios' };
    const integracion = await this.usuarioIntegracion();
    const humanos = evento.items.filter((i) => decidirWebhook({ parentId: null, usuarioId: String(i.user?.id ?? '') }, integracion).procesar);
    if (humanos.length === 0) return { estado: 'ignorado', motivo: 'escritura_del_sistema' };

    // Un cambio de estado, responsable, fecha… no es de un campo personalizado: ni se piden los campos de la lista a ClickUp.
    if (!humanos.some((i) => typeof i.field !== 'string' || i.field === 'custom_field')) return { estado: 'ignorado', motivo: 'campo_no_vigilado' };

    const campos = await this.camposLista();
    const tocados = humanos.map((i) => camposTocados(i, campos)).reduce(unirTocados, { ...NINGUNO });
    if (!Object.values(tocados).some(Boolean)) return { estado: 'ignorado', motivo: 'campo_no_vigilado' };

    const tarea = await this.deps.clickup.tarea(evento.tareaId);
    if (!tarea.esPadre) return { estado: 'ignorado', motivo: 'subtarea' };

    const ahora = (this.deps.ahora ?? (() => new Date()))();
    const tocaron = humanos.filter((i) => Object.values(camposTocados(i, campos)).some(Boolean));
    const ultimo = tocaron[tocaron.length - 1] ?? humanos[humanos.length - 1]!;
    const fecha = aIso(
      tocaron.map((i) => Number(i.date)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => b - a)[0],
      ahora,
    );
    const usuarioId = ultimo.user?.id === undefined || ultimo.user?.id === null ? null : String(ultimo.user.id);

    const conexion = await this.deps.conexion();
    let calculo: { r: ResultadoRecalculo; registrado: string[] } | null;
    try {
      calculo = await enTransaccion(conexion, () => this.reconciliar(conexion, tarea, tocados, fecha, usuarioId));
    } finally {
      conexion.release?.();
    }
    if (calculo === null) return { estado: 'ignorado', motivo: 'lead_sin_calificar' };

    const plan = planEscritura(calculo.r.escrituras, campos);
    const pendientes = camposDesactualizados(calculo.r.escrituras, tarea);
    const aEscribir: PlanEscritura = { cambios: plan.cambios.filter((c) => pendientes.has(c.clave)), omitidos: plan.omitidos };
    const camposEscritos = aEscribir.cambios.length > 0 ? await escribirPlan(this.deps.clickup, tarea.id, aEscribir) : 0;
    return { estado: 'procesado', registrado: calculo.registrado, camposEscritos, omitidos: plan.omitidos };
  }

  /** Dentro de la transacción: registra los cambios manuales y recalcula. Null si el lead no se conocía y no hay nada que registrar. */
  private async reconciliar(
    db: Db, tarea: TareaClickUp, tocados: Tocados, fecha: string, usuarioId: string | null,
  ): Promise<{ r: ResultadoRecalculo; registrado: string[] } | null> {
    await bloquearLead(db, tarea.id);
    const estado = await cargarEstado(db, tarea.id);
    const acciones = accionesManuales({
      tocados,
      ck: leerCampos(tarea),
      previo: estado.previo,
      categoriaPorMatriz: estado.categoriaPorMatriz,
      categoriaAntesDeNoApto: await categoriaAntesDeNoApto(db, tarea.id),
    });
    const hayCambio = acciones.presupuesto !== null || acciones.noApto !== null || acciones.categoria !== null;
    // Un lead que el sistema nunca calificó no se da de alta por tocar un campo cualquiera: solo si hay un cambio que registrar.
    if (estado.previo === null && !hayCambio) return null;

    const registrado: string[] = [];
    let r: ResultadoRecalculo | null = null;
    if (acciones.presupuesto !== null) {
      await registrarPresupuestoManual(db, { clickupTaskId: tarea.id, valor: acciones.presupuesto, usuarioId, fecha });
      r = await recalcularLead(db, tarea.id, { disparador: 'presupuesto' });
      registrado.push('presupuesto_manual');
    }
    if (acciones.noApto !== null) {
      await registrarNoAptoManual(db, { clickupTaskId: tarea.id, valor: acciones.noApto, usuarioId: usuarioId ?? 'clickup', fecha });
      registrado.push(acciones.noApto ? 'no_apto_marcado' : 'no_apto_quitado');
    }
    if (acciones.categoria !== null) {
      r = await recalcularLead(db, tarea.id, { disparador: 'categoria_manual', categoriaElegida: acciones.categoria });
      registrado.push('categoria_manual');
    }
    // Sin cambio manual (p. ej. alguien editó un campo del sistema): se recalcula para restituir lo que escribe el sistema.
    r ??= await recalcularLead(db, tarea.id, { disparador: 'recalculo' });
    return { r, registrado };
  }
}
