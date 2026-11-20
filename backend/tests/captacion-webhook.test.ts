import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureCaptacion } from '../netelip/captacion/schema.ts';
import { abrirBaseAislada, hayBaseDePruebas, type BaseAislada } from './helpers/captacion-base.ts';
import { ClickUpClient, indiceOrdenDe, NOMBRES_CAMPOS, type CampoLista, type TareaClickUp } from '../netelip/captacion/clickup.ts';
import { recalcularLead, registrarPresupuestoFormulario, registrarPresupuestoManual, registrarResumenLlamada, type Db } from '../netelip/captacion/repositorio.ts';
import {
  accionesManuales, camposDesactualizados, camposTocados, firmaValida, leerCampos, leerEvento, ProcesadorWebhook, unirTocados,
  type Conexion, type EventoClickUp, type ItemHistorial, type Tocados,
} from '../netelip/captacion/webhook.ts';
import { configWebhookDesdeEnv, registrarWebhookCaptacion, RUTA_WEBHOOK_CAPTACION } from '../netelip/captacion/webhook-ruta.ts';

// ---------------------------------------------------------------------------------------------
// Firma y lectura del aviso
// ---------------------------------------------------------------------------------------------

const firmar = (cuerpo: string | Buffer, secreto: string): string => createHmac('sha256', secreto).update(cuerpo).digest('hex');

describe('firma del webhook', () => {
  const cuerpo = Buffer.from('{"event":"taskUpdated",  "task_id":"abc123"}');
  it('acepta la firma correcta del cuerpo exacto', () => {
    expect(firmaValida(cuerpo, firmar(cuerpo, 's3creto'), 's3creto')).toBe(true);
  });
  it('rechaza otro secreto, un cuerpo cambiado en un byte y una firma que no es hex ni mide lo que debe', () => {
    expect(firmaValida(cuerpo, firmar(cuerpo, 'otro'), 's3creto')).toBe(false);
    expect(firmaValida(Buffer.from(cuerpo.toString().replace('abc123', 'abc124')), firmar(cuerpo, 's3creto'), 's3creto')).toBe(false);
    expect(firmaValida(cuerpo, 'zz', 's3creto')).toBe(false);
    expect(firmaValida(cuerpo, firmar(cuerpo, 's3creto').slice(0, 62), 's3creto')).toBe(false);
    expect(firmaValida(cuerpo, firmar(cuerpo, 's3creto') + '00', 's3creto')).toBe(false);
  });
  it('sin firma o sin secreto configurado nunca valida (ni siquiera la firma del secreto vacío)', () => {
    expect(firmaValida(cuerpo, undefined, 's3creto')).toBe(false);
    expect(firmaValida(cuerpo, '', 's3creto')).toBe(false);
    expect(firmaValida(cuerpo, firmar(cuerpo, ''), '')).toBe(false);
  });
  it('acepta la firma en mayúsculas o con espacios alrededor (hex es hex)', () => {
    expect(firmaValida(cuerpo, ` ${firmar(cuerpo, 's3creto').toUpperCase()} `, 's3creto')).toBe(true);
  });
});

describe('lectura del aviso', () => {
  const b = (o: unknown): Buffer => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o));
  it('lee el evento, la tarea y los cambios', () => {
    expect(leerEvento(b({ event: 'taskUpdated', task_id: 'abc123', history_items: [{ id: '1', field: 'status' }] }))).toEqual({
      evento: 'taskUpdated', tareaId: 'abc123', items: [{ id: '1', field: 'status' }],
    });
  });
  it('sin history_items da una lista vacía', () => {
    expect(leerEvento(b({ event: 'taskUpdated', task_id: 'abc123' }))?.items).toEqual([]);
  });
  it('descarta lo que no es un objeto con evento y una tarea de id válido', () => {
    expect(leerEvento(b('no es json'))).toBeNull();
    expect(leerEvento(b([1, 2]))).toBeNull();
    expect(leerEvento(b('null'))).toBeNull();
    expect(leerEvento(b({ event: 'taskUpdated' }))).toBeNull();
    expect(leerEvento(b({ task_id: 'abc' }))).toBeNull();
    expect(leerEvento(b({ event: 'taskUpdated', task_id: '../x' }))).toBeNull();
    expect(leerEvento(b({ event: 'taskUpdated', task_id: 5 }))).toBeNull();
  });
  it('ignora los elementos del historial que no son objetos', () => {
    expect(leerEvento(b({ event: 'taskUpdated', task_id: 'a', history_items: [null, 3, 'x', [1], { id: 'ok' }] }))?.items).toEqual([{ id: 'ok' }]);
  });
});

// ---------------------------------------------------------------------------------------------
// Datos de la lista y de las tareas de mentira
// ---------------------------------------------------------------------------------------------

const opciones = (nombres: string[]) => nombres.map((name, i) => ({ id: `op-${name}`, name, orderindex: i }));
const CAMPOS: CampoLista[] = [
  { id: 'f-cat', name: NOMBRES_CAMPOS.categoria, type: 'drop_down', opciones: opciones(['A+', 'A', 'B', 'C', 'D', 'Sin calificar', 'No apto']) },
  { id: 'f-pres', name: NOMBRES_CAMPOS.presupuesto, type: 'currency', opciones: [] },
  { id: 'f-pond', name: NOMBRES_CAMPOS.ponderado, type: 'currency', opciones: [] },
  { id: 'f-fuente', name: NOMBRES_CAMPOS.fuente_presupuesto, type: 'drop_down', opciones: opciones(['Formulario', 'Llamada', 'Reunión', 'WhatsApp', 'Fase 2 LYN', 'Manual', 'Pendiente: preguntar en la 1ª llamada']) },
  { id: 'f-idx', name: NOMBRES_CAMPOS.indice_orden, type: 'number', opciones: [] },
  { id: 'f-des', name: NOMBRES_CAMPOS.desglose, type: 'short_text', opciones: [] },
  { id: 'f-res', name: NOMBRES_CAMPOS.resumen, type: 'text', opciones: [] },
  { id: 'f-nc', name: NOMBRES_CAMPOS.no_continuidad, type: 'drop_down', opciones: opciones(['Presupuesto insuficiente', 'Otro motivo']) },
  { id: 'f-etapa', name: NOMBRES_CAMPOS.etapa, type: 'drop_down', opciones: opciones(['e3. VIABILIDAD', 'e4. VISITA']) },
];
const ID_DE: Record<string, string> = Object.fromEntries(CAMPOS.map((c) => [c.id, c.name]));

const tareaBase = (id: string, campos: TareaClickUp['campos'] = {}): TareaClickUp => ({
  id, nombre: 'Lead de prueba', esPadre: true, estado: 'abierta', cerrada: false, creadaEn: 0, campos: { ...campos },
});

/** ClickUp de mentira: una tarea editable, el registro de lo que se pide y lo que se escribe (los POST cambian la tarea). */
class ClickUpFalso {
  tareas = new Map<string, TareaClickUp>();
  lecturas: string[] = [];
  escrituras: Array<{ tarea: string; campo: string; valor: string | number }> = [];
  fallaLectura = false;
  /** Cuántas lecturas seguidas fallan (y después vuelve a ir bien). */
  fallasLectura = 0;
  usuario = '99';
  activas = 0;
  maxActivas = 0;
  esperaMs = 0;
  async usuarioActual(): Promise<string> { return this.usuario; }
  camposPedidos = 0;
  async campos(): Promise<CampoLista[]> { this.camposPedidos += 1; return CAMPOS; }
  async tarea(id: string): Promise<TareaClickUp> {
    this.lecturas.push(id);
    this.activas += 1;
    this.maxActivas = Math.max(this.maxActivas, this.activas);
    try {
      if (this.esperaMs) await new Promise((r) => setTimeout(r, this.esperaMs));
      if (this.fallaLectura) throw new Error('ClickUp respondió 500');
      if (this.fallasLectura > 0) {
        this.fallasLectura -= 1;
        throw new Error('ClickUp respondió 500');
      }
      const t = this.tareas.get(id) ?? this.tareas.get('*');
      if (!t) throw new Error('tarea desconocida');
      return { ...t, id, campos: { ...t.campos } };
    } finally {
      this.activas -= 1;
    }
  }
  async escribirCampo(tarea: string, campoId: string, valor: string | number): Promise<void> {
    this.escrituras.push({ tarea, campo: ID_DE[campoId] ?? campoId, valor });
    const t = this.tareas.get(tarea);
    if (!t) return;
    const campo = CAMPOS.find((c) => c.id === campoId)!;
    t.campos[campo.name] = campo.opciones.length ? campo.opciones.find((o) => o.id === valor)!.name : valor;
  }
}

const MS = (dia: number): number => Date.UTC(2026, 10, dia, 12, 0, 0);
const AHORA = new Date('2026-11-17T12:00:00.000Z');
const COMERCIAL = 7;
let numeroItem = 0;

/** Un cambio de campo personalizado hecho por `usuario`. */
const cambio = (nombre: string, usuario: number = COMERCIAL, dia = 17): ItemHistorial => ({
  id: `h${++numeroItem}`, field: 'custom_field', date: String(MS(dia)), parent_id: '901211441576', user: { id: usuario },
  custom_field: { id: CAMPOS.find((c) => c.name === nombre)!.id, name: nombre }, before: null, after: null,
});
const evento = (tareaId: string, ...items: ItemHistorial[]): EventoClickUp => ({ evento: 'taskUpdated', tareaId, items });

// ---------------------------------------------------------------------------------------------
// Qué campo tocó un cambio
// ---------------------------------------------------------------------------------------------

const solo = (...claves: Array<keyof Tocados>): Tocados => ({
  categoria: claves.includes('categoria'), presupuesto: claves.includes('presupuesto'),
  no_continuidad: claves.includes('no_continuidad'), sistema: claves.includes('sistema'),
});

describe('qué campo tocó un cambio', () => {
  it('un cambio de estado, responsable o fecha no toca ningún campo vigilado', () => {
    expect(camposTocados({ field: 'status', user: { id: 1 } }, CAMPOS)).toEqual(solo());
    expect(camposTocados({ field: 'assignee_add', user: { id: 1 } }, CAMPOS)).toEqual(solo());
  });
  it('reconoce cada campo vigilado por su nombre', () => {
    expect(camposTocados(cambio(NOMBRES_CAMPOS.categoria), CAMPOS)).toEqual(solo('categoria'));
    expect(camposTocados(cambio(NOMBRES_CAMPOS.presupuesto), CAMPOS)).toEqual(solo('presupuesto'));
    expect(camposTocados(cambio(NOMBRES_CAMPOS.no_continuidad), CAMPOS)).toEqual(solo('no_continuidad'));
    expect(camposTocados(cambio(NOMBRES_CAMPOS.ponderado), CAMPOS)).toEqual(solo('sistema'));
    expect(camposTocados(cambio(NOMBRES_CAMPOS.fuente_presupuesto), CAMPOS)).toEqual(solo('sistema'));
    expect(camposTocados(cambio(NOMBRES_CAMPOS.indice_orden), CAMPOS)).toEqual(solo('sistema'));
    expect(camposTocados(cambio(NOMBRES_CAMPOS.desglose), CAMPOS)).toEqual(solo('sistema'));
    expect(camposTocados(cambio(NOMBRES_CAMPOS.resumen), CAMPOS)).toEqual(solo('sistema'));
  });
  it('lo reconoce por el id del campo aunque el aviso no traiga el nombre', () => {
    expect(camposTocados({ field: 'custom_field', custom_field: { id: 'f-nc' }, user: { id: 1 } }, CAMPOS)).toEqual(solo('no_continuidad'));
  });
  it('un cambio que no es de un campo personalizado no cuenta aunque su texto nombre un campo', () => {
    expect(camposTocados({ field: 'name', after: 'valoracion_interna', user: { id: 1 } }, CAMPOS)).toEqual(solo());
  });
  it('lo reconoce solo por el nombre cuando el aviso no trae el id', () => {
    expect(camposTocados({ field: 'custom_field', custom_field: { name: NOMBRES_CAMPOS.no_continuidad }, user: { id: 1 } }, CAMPOS)).toEqual(solo('no_continuidad'));
    expect(camposTocados({ field: 'custom_field', custom_field: { name: NOMBRES_CAMPOS.presupuesto }, user: { id: 1 } }, CAMPOS)).toEqual(solo('presupuesto'));
  });
  it('al unir los cambios de varios elementos no se pierde ningún campo', () => {
    expect(unirTocados(solo('categoria'), solo('presupuesto'))).toEqual(solo('categoria', 'presupuesto'));
    expect(unirTocados(solo('presupuesto'), solo('categoria'))).toEqual(solo('categoria', 'presupuesto'));
    expect(unirTocados(solo('no_continuidad'), solo('sistema'))).toEqual(solo('no_continuidad', 'sistema'));
    expect(unirTocados(solo('sistema'), solo('no_continuidad'))).toEqual(solo('no_continuidad', 'sistema'));
    expect(unirTocados(solo(), solo())).toEqual(solo());
  });
  it('un campo de la lista que no se vigila (la etapa) no cuenta', () => {
    expect(camposTocados(cambio(NOMBRES_CAMPOS.etapa), CAMPOS)).toEqual(solo());
  });
  it('un campo personalizado que el aviso no identifica cuenta como cualquiera de los vigilados', () => {
    expect(camposTocados({ field: 'custom_field', user: { id: 1 } }, CAMPOS)).toEqual(solo('categoria', 'presupuesto', 'no_continuidad', 'sistema'));
  });
  it('el nombre del usuario que hizo el cambio no se confunde con un campo', () => {
    expect(camposTocados({ field: 'status', user: { id: 1, username: 'valoracion_interna' } }, CAMPOS)).toEqual(solo());
    expect(camposTocados({ field: 'custom_field', custom_field: { id: 'f-etapa' }, user: { id: 1, username: 'valoracion_interna' } }, CAMPOS)).toEqual(solo());
  });
});

// ---------------------------------------------------------------------------------------------
// Lectura de la tarea y decisión
// ---------------------------------------------------------------------------------------------

describe('lectura de la tarea', () => {
  it('traduce la categoría, el presupuesto y el motivo', () => {
    const t = tareaBase('t', { valoracion_interna: 'No apto', presupuesto_estimado: '50000', 'No continuidad': ' Presupuesto insuficiente ' });
    expect(leerCampos(t)).toEqual({ categoria: 'no_apto', presupuesto: 50000, noContinuidad: 'Presupuesto insuficiente' });
  });
  it('vacío, 0, texto o una categoría desconocida dan null', () => {
    expect(leerCampos(tareaBase('t'))).toEqual({ categoria: null, presupuesto: null, noContinuidad: null });
    expect(leerCampos(tareaBase('t', { valoracion_interna: 'Z', presupuesto_estimado: 0, 'No continuidad': '  ' }))).toEqual({ categoria: null, presupuesto: null, noContinuidad: null });
    expect(leerCampos(tareaBase('t', { presupuesto_estimado: 'mucho' })).presupuesto).toBeNull();
    expect(leerCampos(tareaBase('t', { presupuesto_estimado: -5 })).presupuesto).toBeNull();
  });
  it('la etiqueta de la categoría se lee sin los espacios de alrededor', () => {
    expect(leerCampos(tareaBase('t', { valoracion_interna: ' C ' })).categoria).toBe('C');
  });
  it('cada etiqueta da su categoría', () => {
    const lee = (v: string) => leerCampos(tareaBase('t', { valoracion_interna: v })).categoria;
    expect(['A+', 'A', 'B', 'C', 'D', 'Sin calificar', 'No apto'].map(lee)).toEqual(['A+', 'A', 'B', 'C', 'D', 'sin_calificar', 'no_apto']);
  });
});

describe('qué cambio manual se registra', () => {
  const previo = (categoria: 'A' | 'B' | 'no_apto' | 'sin_calificar', presupuestoVigente: number | null) => ({ categoria, presupuestoVigente });
  const base = { categoriaPorMatriz: false, categoriaAntesDeNoApto: 'B' as const };
  const ck = (c: Partial<ReturnType<typeof leerCampos>> = {}) => ({ categoria: null, presupuesto: null, noContinuidad: null, ...c });
  const vacio = { presupuesto: null, noApto: null, categoria: null };

  it('un humano cambia la categoría: se registra esa categoría', () => {
    expect(accionesManuales({ ...base, tocados: solo('categoria'), ck: ck({ categoria: 'C' }), previo: previo('B', 70000) })).toEqual({ ...vacio, categoria: 'C' });
  });
  it('si la categoría de ClickUp ya es la del sistema, no hay cambio', () => {
    expect(accionesManuales({ ...base, tocados: solo('categoria'), ck: ck({ categoria: 'B' }), previo: previo('B', 70000) })).toEqual(vacio);
  });
  it('si el aviso no tocó la categoría, una diferencia (escritura fallida del sistema) no se toma por un cambio manual', () => {
    expect(accionesManuales({ ...base, tocados: solo('sistema'), ck: ck({ categoria: 'C' }), previo: previo('B', 70000) })).toEqual(vacio);
  });
  it('categoría vacía: no se registra (el sistema la restituye), tampoco quitando un No apto', () => {
    expect(accionesManuales({ ...base, tocados: solo('categoria'), ck: ck({ categoria: null }), previo: previo('B', 70000) })).toEqual(vacio);
    expect(accionesManuales({ ...base, tocados: solo('categoria'), ck: ck({ categoria: null }), previo: previo('no_apto', 70000) })).toEqual(vacio);
  });
  it('el motivo de No continuidad solo cuenta si el aviso lo tocó', () => {
    expect(accionesManuales({ ...base, tocados: solo('sistema'), ck: ck({ noContinuidad: 'Presupuesto insuficiente' }), previo: previo('B', 70000) })).toEqual(vacio);
    expect(accionesManuales({ ...base, tocados: solo('sistema'), ck: ck({ noContinuidad: null }), previo: previo('no_apto', 70000) })).toEqual(vacio);
    expect(accionesManuales({ ...base, tocados: solo('categoria'), ck: ck({ categoria: 'B', noContinuidad: null }), previo: previo('no_apto', 70000) })).toEqual({ ...vacio, categoria: 'B', noApto: false });
    expect(accionesManuales({ ...base, tocados: solo('presupuesto'), ck: ck({ noContinuidad: 'Presupuesto insuficiente', presupuesto: 70000 }), previo: previo('B', 70000) })).toEqual(vacio);
  });
  it('un lead sin historial al que le ponen una categoría se registra', () => {
    expect(accionesManuales({ ...base, tocados: solo('categoria'), ck: ck({ categoria: 'A' }), previo: null })).toEqual({ ...vacio, categoria: 'A' });
  });
  it('poner No apto a mano lo marca; sacarlo de No apto lo quita', () => {
    expect(accionesManuales({ ...base, tocados: solo('categoria'), ck: ck({ categoria: 'no_apto' }), previo: previo('B', 70000) })).toEqual({ ...vacio, categoria: 'no_apto', noApto: true });
    expect(accionesManuales({ ...base, tocados: solo('categoria'), ck: ck({ categoria: 'C' }), previo: previo('no_apto', 70000) })).toEqual({ ...vacio, categoria: 'C', noApto: false });
  });
  it('un presupuesto distinto del vigente se registra, redondeado al euro', () => {
    expect(accionesManuales({ ...base, tocados: solo('presupuesto'), ck: ck({ presupuesto: 120000.4 }), previo: previo('B', 70000) })).toEqual({ ...vacio, presupuesto: 120000 });
  });
  it('el mismo presupuesto, vacío o con el campo sin tocar no se registra', () => {
    expect(accionesManuales({ ...base, tocados: solo('presupuesto'), ck: ck({ presupuesto: 70000 }), previo: previo('B', 70000) })).toEqual(vacio);
    expect(accionesManuales({ ...base, tocados: solo('presupuesto'), ck: ck({ presupuesto: 70000.2 }), previo: previo('B', 70000) })).toEqual(vacio);
    expect(accionesManuales({ ...base, tocados: solo('presupuesto'), ck: ck({ presupuesto: null }), previo: previo('B', 70000) })).toEqual(vacio);
    expect(accionesManuales({ ...base, tocados: solo('sistema'), ck: ck({ presupuesto: 99999 }), previo: previo('B', 70000) })).toEqual(vacio);
  });
  it('un presupuesto a un lead sin historial ni presupuesto se registra', () => {
    expect(accionesManuales({ ...base, tocados: solo('presupuesto'), ck: ck({ presupuesto: 50000 }), previo: null })).toEqual({ ...vacio, presupuesto: 50000 });
    expect(accionesManuales({ ...base, tocados: solo('presupuesto'), ck: ck({ presupuesto: 50000 }), previo: previo('sin_calificar', null) })).toEqual({ ...vacio, presupuesto: 50000 });
  });
  it('No continuidad = Presupuesto insuficiente equivale a marcar No apto', () => {
    expect(accionesManuales({ ...base, tocados: solo('no_continuidad'), ck: ck({ noContinuidad: 'Presupuesto insuficiente' }), previo: previo('B', 70000) })).toEqual({ ...vacio, categoria: 'no_apto', noApto: true });
  });
  it('si ya estaba en No apto, el motivo no vuelve a marcar nada', () => {
    expect(accionesManuales({ ...base, tocados: solo('no_continuidad'), ck: ck({ noContinuidad: 'Presupuesto insuficiente' }), previo: previo('no_apto', 70000) })).toEqual(vacio);
  });
  it('otro motivo o motivo vacío no hace nada si el lead no estaba en No apto', () => {
    expect(accionesManuales({ ...base, tocados: solo('no_continuidad'), ck: ck({ noContinuidad: 'Otro motivo' }), previo: previo('B', 70000) })).toEqual(vacio);
    expect(accionesManuales({ ...base, tocados: solo('no_continuidad'), ck: ck({ noContinuidad: null }), previo: previo('B', 70000) })).toEqual(vacio);
  });
  it('el motivo deja de ser Presupuesto insuficiente y el No apto era manual: vuelve la categoría de antes', () => {
    expect(accionesManuales({ ...base, tocados: solo('no_continuidad'), ck: ck({ noContinuidad: null }), previo: previo('no_apto', 70000) })).toEqual({ ...vacio, categoria: 'B', noApto: false });
    expect(accionesManuales({ ...base, tocados: solo('no_continuidad'), ck: ck({ noContinuidad: 'Otro motivo' }), previo: previo('no_apto', 70000) })).toEqual({ ...vacio, categoria: 'B', noApto: false });
  });
  it('si el No apto lo puso la matriz, quitar el motivo no lo levanta', () => {
    expect(accionesManuales({ ...base, categoriaPorMatriz: true, tocados: solo('no_continuidad'), ck: ck({ noContinuidad: null }), previo: previo('no_apto', 70000) })).toEqual(vacio);
  });
  it('si en el mismo aviso cambian el motivo a Presupuesto insuficiente y la categoría, manda el motivo (No apto manda sobre todo)', () => {
    expect(accionesManuales({ ...base, tocados: solo('categoria', 'no_continuidad'), ck: ck({ categoria: 'C', noContinuidad: 'Presupuesto insuficiente' }), previo: previo('B', 70000) })).toEqual({ ...vacio, categoria: 'no_apto', noApto: true });
  });
  it('si en el mismo aviso quitan el motivo y eligen una categoría, manda la categoría elegida', () => {
    expect(accionesManuales({ ...base, tocados: solo('categoria', 'no_continuidad'), ck: ck({ categoria: 'C', noContinuidad: null }), previo: previo('no_apto', 70000) })).toEqual({ ...vacio, categoria: 'C', noApto: false });
  });
  it('mientras el motivo siga siendo Presupuesto insuficiente, elegir otra categoría no saca al lead de No apto', () => {
    // El lead ya está en No apto: no hay nada que registrar (el sistema restituye la categoría en ClickUp).
    expect(accionesManuales({ ...base, tocados: solo('categoria'), ck: ck({ categoria: 'B', noContinuidad: 'Presupuesto insuficiente' }), previo: previo('no_apto', 70000) })).toEqual(vacio);
    // El lead no estaba en No apto (se perdió el aviso del motivo): se pone en No apto.
    expect(accionesManuales({ ...base, tocados: solo('categoria'), ck: ck({ categoria: 'B', noContinuidad: 'Presupuesto insuficiente' }), previo: previo('B', 70000) })).toEqual({ ...vacio, categoria: 'no_apto', noApto: true });
  });
  it('categoría y presupuesto a la vez se registran los dos', () => {
    expect(accionesManuales({ ...base, tocados: solo('categoria', 'presupuesto'), ck: ck({ categoria: 'A', presupuesto: 90000 }), previo: previo('B', 70000) })).toEqual({ ...vacio, categoria: 'A', presupuesto: 90000 });
  });
});

describe('qué campos del sistema están desactualizados', () => {
  const esc = { categoria: 'B' as const, presupuesto: 70000, ponderado: 52500, fuente_presupuesto: 'Formulario', desglose: 'Pres A · Urg B' };
  const igual = (): TareaClickUp => tareaBase('t', {
    valoracion_interna: 'B', presupuesto_estimado: 70000, valor_del_negocio: '52500', 'Fuente del presupuesto': 'Formulario',
    'Índice de orden': indiceOrdenDe('B', 52500), 'Desglose de calificación': 'Pres A · Urg B',
  });
  it('con todo igual no hay nada que escribir (números como texto incluidos)', () => {
    expect([...camposDesactualizados(esc, igual())]).toEqual([]);
  });
  it('detecta cada campo que no coincide', () => {
    const t = igual();
    Object.assign(t.campos, { valoracion_interna: 'C', presupuesto_estimado: 1, valor_del_negocio: 2, 'Fuente del presupuesto': 'Manual', 'Índice de orden': 3, 'Desglose de calificación': 'x' });
    expect([...camposDesactualizados(esc, t)].sort()).toEqual(['categoria', 'desglose', 'fuente_presupuesto', 'indice_orden', 'ponderado', 'presupuesto']);
  });
  it('un No apto con ponderado 0 y el campo vacío está desactualizado (el vacío no es 0)', () => {
    // ClickUp devuelve un campo vacío como null (no ausente): el vacío no es 0.
    const t = tareaBase('t', { valoracion_interna: 'No apto', 'Fuente del presupuesto': 'Manual', 'Índice de orden': indiceOrdenDe('no_apto', 0), valor_del_negocio: null });
    expect([...camposDesactualizados({ categoria: 'no_apto', presupuesto: null, ponderado: 0, fuente_presupuesto: 'Manual' }, t)]).toEqual(['ponderado']);
    t.campos.valor_del_negocio = 0;
    expect([...camposDesactualizados({ categoria: 'no_apto', presupuesto: null, ponderado: 0, fuente_presupuesto: 'Manual' }, t)]).toEqual([]);
  });
  it('el desglose se compara sin los espacios de alrededor', () => {
    const t = igual();
    t.campos['Desglose de calificación'] = 'Pres A · Urg B';
    expect([...camposDesactualizados({ ...esc, desglose: ' Pres A · Urg B  ' }, t)]).toEqual([]);
  });
  it('el resumen ejecutivo se compara por su texto, sin los espacios de alrededor; sin resumen del sistema no se compara', () => {
    const texto = 'Qué quiere: x\nDónde quedó: y\nQué lo frena: z\nPara qué llamarlo: w';
    const t = igual();
    t.campos['Resumen ejecutivo'] = texto;
    expect([...camposDesactualizados({ ...esc, resumen: texto }, t)]).toEqual([]);
    expect([...camposDesactualizados({ ...esc, resumen: `  ${texto}\n ` }, t)]).toEqual([]);
    t.campos['Resumen ejecutivo'] = 'lo que escribió un comercial';
    expect([...camposDesactualizados({ ...esc, resumen: texto }, t)]).toEqual(['resumen']);
    t.campos['Resumen ejecutivo'] = null;
    expect([...camposDesactualizados({ ...esc, resumen: texto }, t)]).toEqual(['resumen']);
    // El lead aún no tiene resumen: lo que haya en el campo no se toca.
    expect([...camposDesactualizados(esc, t)]).toEqual([]);
  });
  it('un texto que no es un número en un campo de importe no se toma por un importe', () => {
    const t = igual();
    t.campos.presupuesto_estimado = 'abc';
    expect([...camposDesactualizados({ ...esc, presupuesto: null }, t)]).toEqual([]);
    expect([...camposDesactualizados({ ...esc, presupuesto: 70000 }, t)]).toEqual(['presupuesto']);
  });
  it('un campo vacío en ClickUp cuenta como desactualizado; sin desglose calculado no se compara', () => {
    const t = igual();
    t.campos['Índice de orden'] = null;
    expect([...camposDesactualizados({ ...esc, desglose: undefined }, t)]).toEqual(['indice_orden']);
  });
  it('un presupuesto o ponderado sin valor del sistema coincide con el campo vacío', () => {
    const t = tareaBase('t', { valoracion_interna: 'Sin calificar', 'Fuente del presupuesto': 'Pendiente: preguntar en la 1ª llamada', 'Índice de orden': indiceOrdenDe('sin_calificar', null) });
    expect([...camposDesactualizados({ categoria: 'sin_calificar', presupuesto: null, ponderado: null, fuente_presupuesto: 'Pendiente: preguntar en la 1ª llamada' }, t)]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// De punta a punta contra Postgres: aviso → registro → recálculo → escritura en ClickUp
// ---------------------------------------------------------------------------------------------

describe.skipIf(!hayBaseDePruebas)('webhook de ClickUp contra Postgres', () => {
  let base: BaseAislada;
  let db: Db;
  let ck: ClickUpFalso;
  let proc: ProcesadorWebhook;

  beforeEach(async () => {
    base = await abrirBaseAislada();
    await ensureCaptacion(base);
    db = base as unknown as Db;
    ck = new ClickUpFalso();
    proc = new ProcesadorWebhook({ conexion: async () => base as unknown as Conexion, clickup: ck as never, ahora: () => AHORA });
  });
  afterEach(async () => {
    await base.cerrar();
  });

  const historial = async (): Promise<string[]> =>
    (await db.query('SELECT categoria, motivo FROM lead_calificacion_historial ORDER BY seq')).rows.map((f) => `${f.motivo}:${f.categoria}`);
  const contar = async (tabla: string): Promise<number> => Number((await db.query(`SELECT count(*)::int AS n FROM ${tabla}`)).rows[0]!.n);

  /** Un lead que ya calificó el sistema: presupuesto del formulario (70.000) y categoría `categoria`; ClickUp lo refleja. */
  async function leadCalificado(categoria: 'A' | 'B' = 'B', id = 'T1'): Promise<void> {
    await registrarPresupuestoFormulario(db, { clickupTaskId: id, opcion: '40.000 – 100.000 €', fechaInteraccion: '2026-11-10T10:00:00.000Z' });
    const r = await recalcularLead(db, id, { disparador: 'alta', categoriaElegida: categoria });
    ck.tareas.set(id, tareaBase(id, {
      valoracion_interna: categoria, presupuesto_estimado: r.escrituras.presupuesto, valor_del_negocio: r.escrituras.ponderado,
      'Fuente del presupuesto': r.escrituras.fuente_presupuesto, 'Índice de orden': indiceOrdenDe(categoria, r.escrituras.ponderado),
    }));
  }
  const editar = (nombre: string, valor: string | number | null, id = 'T1'): void => {
    ck.tareas.get(id)!.campos[nombre] = valor;
  };

  it('un comercial cambia la categoría: queda registrado y el ponderado se recalcula en ClickUp', async () => {
    await leadCalificado('B');
    editar('valoracion_interna', 'C');
    const r = await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    expect(r).toMatchObject({ estado: 'procesado', registrado: ['categoria_manual'], camposEscritos: 2 });
    expect(await historial()).toEqual(['alta:B', 'cambio_categoria_manual:C']);
    expect(ck.tareas.get('T1')!.campos).toMatchObject({ valoracion_interna: 'C', valor_del_negocio: 31500, 'Índice de orden': indiceOrdenDe('C', 31500) });
    // La categoría ya la había puesto el humano: no se vuelve a escribir.
    expect(ck.escrituras.map((e) => e.campo).sort()).toEqual([NOMBRES_CAMPOS.ponderado, NOMBRES_CAMPOS.indice_orden].sort());
  });

  it('repetir el mismo aviso no duplica nada ni vuelve a escribir', async () => {
    await leadCalificado('B');
    editar('valoracion_interna', 'C');
    await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    const escritos = ck.escrituras.length;
    const r = await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    expect(r).toMatchObject({ estado: 'procesado', registrado: [], camposEscritos: 0 });
    expect(ck.escrituras.length).toBe(escritos);
    expect(await historial()).toEqual(['alta:B', 'cambio_categoria_manual:C']);
  });

  it('A+ elegida a mano sin presupuesto de 100.000 € vuelve a A y ClickUp se corrige', async () => {
    await leadCalificado('A');
    editar('valoracion_interna', 'A+');
    const r = await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    expect(r).toMatchObject({ estado: 'procesado', registrado: ['categoria_manual'] });
    expect(await historial()).toEqual(['alta:A', 'cambio_categoria_manual:A+', 'cambio_categoria_manual:A']);
    expect(ck.tareas.get('T1')!.campos.valoracion_interna).toBe('A');
  });

  it('un presupuesto escrito a mano cuenta como fuente Manual y manda por su fecha', async () => {
    await leadCalificado('B');
    editar('presupuesto_estimado', 120000);
    const r = await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.presupuesto)));
    expect(r).toMatchObject({ estado: 'procesado', registrado: ['presupuesto_manual'], camposEscritos: 3 });
    expect(ck.tareas.get('T1')!.campos).toMatchObject({ presupuesto_estimado: 120000, valor_del_negocio: 90000, 'Fuente del presupuesto': 'Manual' });
    expect(await historial()).toEqual(['alta:B', 'cambio_presupuesto:B']);
    const evt = (await db.query("SELECT fuente, emisor, registrado_por, usuario_id, valor_vigente::int AS v, fecha_interaccion FROM lead_presupuesto_evento WHERE fuente = 'manual'")).rows;
    expect(evt).toHaveLength(1);
    expect(evt[0]).toMatchObject({ fuente: 'manual', emisor: 'cliente', registrado_por: 'usuario', usuario_id: '7', v: 120000 });
    expect(new Date(String(evt[0]!.fecha_interaccion)).toISOString()).toBe(new Date(MS(17)).toISOString());
  });

  it('el mismo presupuesto manual reenviado no se registra dos veces', async () => {
    await leadCalificado('B');
    editar('presupuesto_estimado', 120000);
    await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.presupuesto)));
    const r = await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.presupuesto)));
    expect(r).toMatchObject({ estado: 'procesado', registrado: [], camposEscritos: 0 });
    expect(await contar('lead_presupuesto_evento')).toBe(2);
    expect(await historial()).toEqual(['alta:B', 'cambio_presupuesto:B']);
  });

  it('un presupuesto vacío o 0 no se registra y el sistema lo restituye', async () => {
    await leadCalificado('B');
    editar('presupuesto_estimado', 0);
    const r = await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.presupuesto)));
    expect(r).toMatchObject({ estado: 'procesado', registrado: [], camposEscritos: 1 });
    expect(ck.tareas.get('T1')!.campos.presupuesto_estimado).toBe(70000);
    expect(await contar('lead_presupuesto_evento')).toBe(1);
  });

  it('No continuidad = Presupuesto insuficiente deja el lead en No apto; al quitarlo vuelve su categoría', async () => {
    await leadCalificado('B');
    editar('No continuidad', 'Presupuesto insuficiente');
    const marcado = await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.no_continuidad)));
    expect(marcado).toMatchObject({ estado: 'procesado', registrado: ['no_apto_marcado', 'categoria_manual'] });
    expect(ck.tareas.get('T1')!.campos).toMatchObject({ valoracion_interna: 'No apto', valor_del_negocio: 0 });
    expect((await db.query('SELECT valor FROM lead_no_apto_evento ORDER BY creado_en')).rows.map((f) => f.valor)).toEqual([true]);

    editar('No continuidad', null);
    const quitado = await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.no_continuidad)));
    expect(quitado).toMatchObject({ estado: 'procesado', registrado: ['no_apto_quitado', 'categoria_manual'] });
    expect(ck.tareas.get('T1')!.campos).toMatchObject({ valoracion_interna: 'B', valor_del_negocio: 52500 });
    expect(await historial()).toEqual(['alta:B', 'cambio_categoria_manual:no_apto', 'cambio_categoria_manual:B']);
    expect((await db.query('SELECT valor FROM lead_no_apto_evento ORDER BY creado_en')).rows.map((f) => f.valor)).toEqual([true, false]);
  });

  it('con el motivo Presupuesto insuficiente puesto, elegir otra categoría no saca al lead de No apto: se restituye', async () => {
    await leadCalificado('B');
    editar('No continuidad', 'Presupuesto insuficiente');
    await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.no_continuidad)));
    expect(ck.tareas.get('T1')!.campos.valoracion_interna).toBe('No apto');
    editar('valoracion_interna', 'C');
    const r = await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    expect(r).toMatchObject({ estado: 'procesado', registrado: [], camposEscritos: 1 });
    expect(ck.tareas.get('T1')!.campos.valoracion_interna).toBe('No apto');
    expect(await historial()).toEqual(['alta:B', 'cambio_categoria_manual:no_apto']);
  });

  it('cada lead se bloquea al empezar su transacción, antes de leer su estado', async () => {
    await leadCalificado('B');
    editar('valoracion_interna', 'C');
    const sqls: Array<{ sql: string; params?: unknown[] }> = [];
    const conexion = async () => ({
      query: (sql: string, params?: unknown[]) => { sqls.push({ sql, params }); return base.query(sql, params); },
      release: () => undefined,
    });
    await new ProcesadorWebhook({ conexion: conexion as never, clickup: ck as never, ahora: () => AHORA }).procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    expect(sqls[0]!.sql).toBe('BEGIN');
    expect(sqls[1]!.sql).toContain('pg_advisory_xact_lock');
    expect(sqls[1]!.params).toEqual([7101, 'T1']);
    expect(sqls[2]!.sql).toContain('lead_presupuesto_evento');
  });

  it('un lead que el sistema nunca calificó queda registrado cuando alguien le pone categoría', async () => {
    ck.tareas.set('T9', tareaBase('T9', { valoracion_interna: 'C' }));
    const r = await proc.procesar(evento('T9', cambio(NOMBRES_CAMPOS.categoria)));
    expect(r).toMatchObject({ estado: 'procesado', registrado: ['categoria_manual'] });
    expect(await historial()).toEqual(['alta:C']);
    expect(ck.tareas.get('T9')!.campos).toMatchObject({ valoracion_interna: 'C', 'Fuente del presupuesto': 'Pendiente: preguntar en la 1ª llamada' });
  });

  it('un lead desconocido al que le tocan un campo sin cambio que registrar no se da de alta', async () => {
    ck.tareas.set('T9', tareaBase('T9', {}));
    const r = await proc.procesar(evento('T9', cambio(NOMBRES_CAMPOS.ponderado)));
    expect(r).toEqual({ estado: 'ignorado', motivo: 'lead_sin_calificar' });
    expect(await contar('lead_calificacion_historial')).toBe(0);
    expect(ck.escrituras).toEqual([]);
  });

  it('si alguien edita un campo que solo escribe el sistema, se restituye sin tocar el histórico', async () => {
    await leadCalificado('B');
    editar('valor_del_negocio', 1);
    const r = await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.ponderado)));
    expect(r).toMatchObject({ estado: 'procesado', registrado: [], camposEscritos: 1 });
    expect(ck.tareas.get('T1')!.campos.valor_del_negocio).toBe(52500);
    expect(await historial()).toEqual(['alta:B']);
  });

  it('si alguien edita el Resumen ejecutivo a mano, se restituye el del sistema (N-1.3) sin tocar el histórico de calificación', async () => {
    await leadCalificado('B');
    await registrarResumenLlamada(db, {
      clickupTaskId: 'T1', interaccionId: 'netelip:1', fechaInteraccion: '2026-11-12T10:00:00.000Z', transcripcion: '', tienePresupuesto: true,
      resumen: { queQuiere: 'Reforma integral', dondeQuedo: 'Cita en oficina', queLoFrena: 'Nada', paraQueLlamarlo: 'Confirmar la cita', fechaPrevista: null, fechaCita: null },
    });
    const esperado = (await recalcularLead(db, 'T1', { disparador: 'recalculo' })).escrituras.resumen!;
    expect(esperado).toContain('Dónde quedó: Cita en oficina');
    editar('Resumen ejecutivo', 'lo que escribió un comercial');
    const r = await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.resumen)));
    expect(r).toMatchObject({ estado: 'procesado', registrado: [], camposEscritos: 1 });
    expect(ck.tareas.get('T1')!.campos['Resumen ejecutivo']).toBe(esperado);
    expect(await historial()).toEqual(['alta:B']);
    // Repetir el aviso no vuelve a escribir: ya coincide.
    const otra = await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.resumen)));
    expect(otra).toMatchObject({ estado: 'procesado', camposEscritos: 0 });
  });

  it('una diferencia que viene de una escritura fallida del sistema se restituye, no se toma por un cambio manual', async () => {
    await leadCalificado('B');
    editar('valoracion_interna', 'C');
    const r = await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.ponderado)));
    expect(r).toMatchObject({ estado: 'procesado', registrado: [] });
    expect(ck.tareas.get('T1')!.campos.valoracion_interna).toBe('B');
    expect(await historial()).toEqual(['alta:B']);
  });

  it('un aviso del usuario de integración se descarta sin leer la tarea', async () => {
    await leadCalificado('B');
    const r = await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria, 99)));
    expect(r).toEqual({ estado: 'ignorado', motivo: 'escritura_del_sistema' });
    expect(ck.lecturas).toEqual([]);
  });

  it('si el aviso mezcla un cambio de la integración y uno humano, cuenta el humano', async () => {
    await leadCalificado('B');
    editar('valoracion_interna', 'C');
    const r = await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.ponderado, 99), cambio(NOMBRES_CAMPOS.categoria, COMERCIAL)));
    expect(r).toMatchObject({ estado: 'procesado', registrado: ['categoria_manual'] });
  });

  it('una subtarea se descarta', async () => {
    ck.tareas.set('S1', { ...tareaBase('S1', { valoracion_interna: 'C' }), esPadre: false });
    const r = await proc.procesar(evento('S1', cambio(NOMBRES_CAMPOS.categoria)));
    expect(r).toEqual({ estado: 'ignorado', motivo: 'subtarea' });
    expect(await contar('lead_calificacion_historial')).toBe(0);
  });

  it('un cambio de estado o de un campo no vigilado se descarta sin leer la tarea', async () => {
    await leadCalificado('B');
    expect(await proc.procesar(evento('T1', { id: 'x', field: 'status', user: { id: COMERCIAL } }))).toEqual({ estado: 'ignorado', motivo: 'campo_no_vigilado' });
    // Un cambio de estado ni siquiera pide los campos de la lista a ClickUp.
    expect(ck.camposPedidos).toBe(0);
    expect(await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.etapa)))).toEqual({ estado: 'ignorado', motivo: 'campo_no_vigilado' });
    expect(ck.lecturas).toEqual([]);
  });

  it('un cambio que no declara su campo pero nombra la categoría también se atiende', async () => {
    await leadCalificado('B');
    editar('valoracion_interna', 'C');
    const sinCampo: ItemHistorial = { id: 'x', user: { id: COMERCIAL }, custom_field: { name: NOMBRES_CAMPOS.categoria } };
    expect(await proc.procesar(evento('T1', sinCampo))).toMatchObject({ estado: 'procesado', registrado: ['categoria_manual'] });
  });

  it('otros eventos y avisos sin cambios se descartan', async () => {
    expect(await proc.procesar({ evento: 'taskCreated', tareaId: 'T1', items: [cambio(NOMBRES_CAMPOS.categoria)] })).toEqual({ estado: 'ignorado', motivo: 'evento_no_soportado' });
    expect(await proc.procesar(evento('T1'))).toEqual({ estado: 'ignorado', motivo: 'sin_cambios' });
    expect(ck.lecturas).toEqual([]);
  });

  it('el usuario de integración sale del dueño del token cuando no se configura', async () => {
    await leadCalificado('B');
    ck.usuario = '7';
    editar('valoracion_interna', 'C');
    expect(await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria, 7)))).toEqual({ estado: 'ignorado', motivo: 'escritura_del_sistema' });
  });

  it('si ClickUp falla al leer la tarea no se guarda nada y el siguiente aviso sí se atiende', async () => {
    await leadCalificado('B');
    editar('valoracion_interna', 'C');
    ck.fallaLectura = true;
    await expect(proc.encolar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)))).rejects.toThrow('ClickUp respondió 500');
    expect(await historial()).toEqual(['alta:B']);
    ck.fallaLectura = false;
    await expect(proc.encolar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)))).resolves.toMatchObject({ estado: 'procesado', registrado: ['categoria_manual'] });
  });

  it('los avisos de una misma tarea se atienden de uno en uno y los de tareas distintas pueden ir a la vez', async () => {
    await leadCalificado('B', 'T1');
    await leadCalificado('B', 'T2');
    ck.esperaMs = 15;
    editar('valoracion_interna', 'C', 'T1');
    editar('valoracion_interna', 'C', 'T2');
    await Promise.all([
      proc.encolar(evento('T1', cambio(NOMBRES_CAMPOS.categoria))),
      proc.encolar(evento('T1', cambio(NOMBRES_CAMPOS.categoria))),
      proc.encolar(evento('T1', cambio(NOMBRES_CAMPOS.categoria))),
    ]);
    expect(ck.maxActivas).toBe(1);
    expect(await historial()).toEqual(['alta:B', 'alta:B', 'cambio_categoria_manual:C']);
    ck.maxActivas = 0;
    await Promise.all([
      proc.encolar(evento('T2', cambio(NOMBRES_CAMPOS.categoria))),
      proc.encolar(evento('T1', cambio(NOMBRES_CAMPOS.categoria))),
    ]);
    expect(ck.maxActivas).toBe(2);
  });

  it('el registro del presupuesto manual no se duplica, redondea al euro y rechaza lo que no es un importe', async () => {
    await leadCalificado('B');
    const fecha = '2026-11-12T10:00:00.000Z';
    expect(await registrarPresupuestoManual(db, { clickupTaskId: 'T1', valor: 80000, usuarioId: '7', fecha })).toBe(true);
    expect(await registrarPresupuestoManual(db, { clickupTaskId: 'T1', valor: 80000, usuarioId: '7', fecha })).toBe(false);
    expect(await registrarPresupuestoManual(db, { clickupTaskId: 'T1', valor: 90000.4, usuarioId: null, fecha })).toBe(true);
    // 90.000,4 y 90.000 son el mismo importe: el segundo no se registra.
    expect(await registrarPresupuestoManual(db, { clickupTaskId: 'T1', valor: 90000, usuarioId: null, fecha })).toBe(false);
    expect((await db.query("SELECT valor_vigente::int AS v, usuario_id FROM lead_presupuesto_evento WHERE fuente = 'manual' ORDER BY valor_vigente")).rows).toEqual([{ v: 80000, usuario_id: '7' }, { v: 90000, usuario_id: null }]);
    for (const valor of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(registrarPresupuestoManual(db, { clickupTaskId: 'T1', valor, usuarioId: '7', fecha })).rejects.toThrow('mayor que 0');
    }
  });

  it('con varios cambios en el aviso, el presupuesto manual lleva la fecha del último', async () => {
    await leadCalificado('B');
    editar('presupuesto_estimado', 120000);
    const antiguo = cambio(NOMBRES_CAMPOS.presupuesto, COMERCIAL, 15);
    const reciente = cambio(NOMBRES_CAMPOS.presupuesto, COMERCIAL, 16);
    await proc.procesar(evento('T1', reciente, antiguo));
    const f = (await db.query("SELECT fecha_interaccion FROM lead_presupuesto_evento WHERE fuente = 'manual'")).rows[0]!.fecha_interaccion;
    expect(new Date(String(f)).toISOString()).toBe(new Date(MS(16)).toISOString());
  });

  it('un cambio sin fecha usa la hora de llegada del aviso', async () => {
    await leadCalificado('B');
    editar('presupuesto_estimado', 120000);
    const sinFecha = cambio(NOMBRES_CAMPOS.presupuesto);
    delete sinFecha.date;
    await proc.procesar(evento('T1', sinFecha));
    const f = (await db.query("SELECT fecha_interaccion FROM lead_presupuesto_evento WHERE fuente = 'manual'")).rows[0]!.fecha_interaccion;
    expect(new Date(String(f)).toISOString()).toBe(AHORA.toISOString());
  });

  it('al quitar el No apto vuelve la última categoría que no era No apto, no la primera', async () => {
    await leadCalificado('A');
    editar('valoracion_interna', 'B');
    await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    editar('No continuidad', 'Presupuesto insuficiente');
    await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.no_continuidad)));
    editar('No continuidad', null);
    await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.no_continuidad)));
    expect(await historial()).toEqual(['alta:A', 'cambio_categoria_manual:B', 'cambio_categoria_manual:no_apto', 'cambio_categoria_manual:B']);
    expect(ck.tareas.get('T1')!.campos.valoracion_interna).toBe('B');
  });

  it('un lead que solo estuvo en No apto vuelve a Sin calificar cuando se levanta', async () => {
    ck.tareas.set('T9', tareaBase('T9', { 'No continuidad': 'Presupuesto insuficiente' }));
    await proc.procesar(evento('T9', cambio(NOMBRES_CAMPOS.no_continuidad)));
    expect(await historial()).toEqual(['alta:no_apto']);
    editar('No continuidad', null, 'T9');
    await proc.procesar(evento('T9', cambio(NOMBRES_CAMPOS.no_continuidad)));
    expect(await historial()).toEqual(['alta:no_apto', 'cambio_categoria_manual:sin_calificar']);
    expect(ck.tareas.get('T9')!.campos.valoracion_interna).toBe('Sin calificar');
  });

  it('un aviso que falla no bloquea al siguiente de la misma tarea que ya estaba esperando', async () => {
    await leadCalificado('B');
    editar('valoracion_interna', 'C');
    ck.fallasLectura = 1;
    const primero = proc.encolar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    const segundo = proc.encolar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    await expect(primero).rejects.toThrow('ClickUp respondió 500');
    await expect(segundo).resolves.toMatchObject({ estado: 'procesado', registrado: ['categoria_manual'] });
  });

  it('la conexión se libera siempre, también cuando falla la base', async () => {
    await leadCalificado('B');
    editar('valoracion_interna', 'C');
    let liberadas = 0;
    let romper = false;
    const conexion = async () => ({
      query: (sql: string, params?: unknown[]) => (romper && sql.includes('FROM lead_presupuesto_evento WHERE') ? Promise.reject(new Error('conexión perdida')) : base.query(sql, params)),
      release: () => { liberadas += 1; },
    });
    const p = new ProcesadorWebhook({ conexion: conexion as never, clickup: ck as never, ahora: () => AHORA });
    await p.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    expect(liberadas).toBe(1);
    romper = true;
    await expect(p.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)))).rejects.toThrow('conexión perdida');
    expect(liberadas).toBe(2);
  });

  it('con varios campos cambiados a la vez se registran todos, en orden: presupuesto y luego categoría con el presupuesto nuevo', async () => {
    await leadCalificado('B');
    editar('valoracion_interna', 'A');
    editar('presupuesto_estimado', 120000);
    const r = await proc.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria), cambio(NOMBRES_CAMPOS.presupuesto)));
    expect(r).toMatchObject({ estado: 'procesado', registrado: ['presupuesto_manual', 'categoria_manual'] });
    expect(await historial()).toEqual(['alta:B', 'cambio_presupuesto:B', 'cambio_categoria_manual:A+']);
    expect(ck.tareas.get('T1')!.campos).toMatchObject({ valoracion_interna: 'A+', valor_del_negocio: 120000 });
  });

  it('los campos de la lista se renuevan a los 10 minutos si no se configura otro tiempo', async () => {
    await leadCalificado('B');
    let reloj = AHORA.getTime();
    const p = new ProcesadorWebhook({ conexion: async () => base as unknown as Conexion, clickup: ck as never, ahora: () => new Date(reloj) });
    editar('valoracion_interna', 'B');
    await p.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    reloj += 600_000;
    await p.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    expect(ck.camposPedidos).toBe(1);
    reloj += 1;
    await p.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    expect(ck.camposPedidos).toBe(2);
  });

  it('los campos de la lista se piden una vez y se renuevan cuando pasa el tiempo de vida', async () => {
    await leadCalificado('B');
    let reloj = AHORA.getTime();
    const p = new ProcesadorWebhook({ conexion: async () => base as unknown as Conexion, clickup: ck as never, ahora: () => new Date(reloj), ttlCamposMs: 1000 });
    editar('valoracion_interna', 'B');
    await p.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    await p.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    reloj += 1000;
    await p.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    expect(ck.camposPedidos).toBe(1);
    reloj += 1;
    await p.procesar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    expect(ck.camposPedidos).toBe(2);
  });

  it('la cola se vacía al terminar, también cuando un aviso falla', async () => {
    await leadCalificado('B');
    editar('valoracion_interna', 'C');
    const a = proc.encolar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)));
    expect(proc.enCurso).toBe(1);
    await a;
    await new Promise((r) => setImmediate(r));
    expect(proc.enCurso).toBe(0);
    ck.fallaLectura = true;
    await expect(proc.encolar(evento('T1', cambio(NOMBRES_CAMPOS.categoria)))).rejects.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(proc.enCurso).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// La ruta HTTP (firma sobre el cuerpo en bruto, respuesta inmediata)
// ---------------------------------------------------------------------------------------------

describe('ruta del webhook', () => {
  const SECRETO = 'secreto-de-prueba';
  let cerrar: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cerrar?.();
    cerrar = null;
  });

  async function levantar(encolar: (e: EventoClickUp) => Promise<unknown>) {
    const app = express();
    const lineas: Array<Record<string, unknown>> = [];
    registrarWebhookCaptacion(app, { encolar: encolar as never }, SECRETO, (l) => lineas.push(l));
    // Como en server.ts: el parser global JSON va DESPUÉS de la ruta.
    app.use(express.json());
    const servidor = app.listen(0, '127.0.0.1');
    await new Promise((r) => servidor.once('listening', r));
    cerrar = () => new Promise((r) => servidor.close(() => r()));
    const url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}${RUTA_WEBHOOK_CAPTACION}`;
    const enviar = (cuerpo: string, firma: string | null, tipo = 'application/json') =>
      fetch(url, { method: 'POST', headers: { 'content-type': tipo, ...(firma === null ? {} : { 'x-signature': firma }) }, body: cuerpo });
    return { enviar, lineas };
  }

  const CUERPO = '{ "event": "taskUpdated",   "task_id": "abc123", "history_items": [] }';

  it('con la firma correcta responde 200 al instante y entrega el aviso, aunque el cuerpo traiga espacios raros', async () => {
    const recibidos: EventoClickUp[] = [];
    const { enviar, lineas } = await levantar(async (e) => { recibidos.push(e); return { estado: 'ignorado', motivo: 'sin_cambios' }; });
    const r = await enviar(CUERPO, firmar(CUERPO, SECRETO));
    expect(r.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recibidos).toEqual([{ evento: 'taskUpdated', tareaId: 'abc123', items: [] }]);
    expect(lineas).toContainEqual({ msg: 'captacion_webhook', tarea: 'abc123', evento: 'taskUpdated', estado: 'ignorado', motivo: 'sin_cambios' });
  });

  it('responde 200 aunque el procesado tarde mucho', async () => {
    const { enviar } = await levantar(() => new Promise(() => undefined));
    expect((await enviar(CUERPO, firmar(CUERPO, SECRETO))).status).toBe(200);
  });

  it('firma incorrecta, ausente o de otro cuerpo: 401 y no se entrega nada', async () => {
    const recibidos: EventoClickUp[] = [];
    const { enviar, lineas } = await levantar(async (e) => { recibidos.push(e); });
    expect((await enviar(CUERPO, firmar(CUERPO, 'otro'))).status).toBe(401);
    expect((await enviar(CUERPO, null)).status).toBe(401);
    expect((await enviar(CUERPO, firmar(CUERPO.replace('abc123', 'abc999'), SECRETO))).status).toBe(401);
    expect(recibidos).toEqual([]);
    expect(lineas.filter((l) => l.msg === 'captacion_webhook_firma_invalida')).toHaveLength(3);
  });

  it('cuerpo firmado pero que no es un aviso de ClickUp: 400', async () => {
    const recibidos: EventoClickUp[] = [];
    const { enviar } = await levantar(async (e) => { recibidos.push(e); });
    expect((await enviar('no es json', firmar('no es json', SECRETO), 'text/plain')).status).toBe(400);
    expect((await enviar('{"event":"taskUpdated"}', firmar('{"event":"taskUpdated"}', SECRETO))).status).toBe(400);
    expect(recibidos).toEqual([]);
  });

  it('un error al procesar se anota (sin el cuerpo) y no tumba la ruta', async () => {
    const { enviar, lineas } = await levantar(async () => { throw new Error('ClickUp respondió 500 en GET /task'); });
    expect((await enviar(CUERPO, firmar(CUERPO, SECRETO))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lineas).toContainEqual({ msg: 'captacion_webhook_error', tarea: 'abc123', error: 'Error', detalle: 'ClickUp respondió 500 en GET /task' });
    expect((await enviar(CUERPO, firmar(CUERPO, SECRETO))).status).toBe(200);
  });
});

describe('usuario dueño del token', () => {
  const cliente = (respuesta: unknown, estado = 200) =>
    new ClickUpClient({
      token: 'pk_x', listaId: '123', pausaMs: 0, maxReintentos: 0,
      fetcher: (async (url: string) => {
        expect(String(url)).toBe('https://api.clickup.com/api/v2/user');
        return new Response(JSON.stringify(respuesta), { status: estado });
      }) as unknown as typeof fetch,
    });
  it('lee el id del usuario de GET /user como texto', async () => {
    expect(await cliente({ user: { id: 183, username: 'x' } }).usuarioActual()).toBe('183');
  });
  it('si ClickUp no lo devuelve, falla en vez de adivinar', async () => {
    await expect(cliente({ user: {} }).usuarioActual()).rejects.toThrow('no devolvió el usuario');
    await expect(cliente({}).usuarioActual()).rejects.toThrow('no devolvió el usuario');
    await expect(cliente({ user: { id: '' } }).usuarioActual()).rejects.toThrow('no devolvió el usuario');
    await expect(cliente({ err: 'x' }, 401).usuarioActual()).rejects.toThrow('401');
  });
});

describe('configuración del webhook por entorno', () => {
  const ok = { CAPTACION_WEBHOOK_ENABLED: 'true', CAPTACION_WEBHOOK_SECRET: 's', CLICKUP_API_TOKEN: 'pk_x', CAPTACION_CLICKUP_LIST_ID: '123' };
  it('está apagado salvo que se active expresamente', () => {
    expect(configWebhookDesdeEnv({})).toEqual({ apagado: 'CAPTACION_WEBHOOK_ENABLED no es true' });
    expect(configWebhookDesdeEnv({ ...ok, CAPTACION_WEBHOOK_ENABLED: '1' })).toHaveProperty('apagado');
  });
  it('si está activado pero falta el secreto o el acceso a ClickUp, sigue apagado y dice por qué', () => {
    expect(configWebhookDesdeEnv({ ...ok, CAPTACION_WEBHOOK_SECRET: ' ' })).toEqual({ apagado: 'falta CAPTACION_WEBHOOK_SECRET' });
    expect(configWebhookDesdeEnv({ ...ok, CLICKUP_API_TOKEN: '' })).toEqual({ apagado: 'faltan CLICKUP_API_TOKEN o CAPTACION_CLICKUP_LIST_ID' });
    expect(configWebhookDesdeEnv({ ...ok, CAPTACION_CLICKUP_LIST_ID: '' })).toHaveProperty('apagado');
  });
  it('activado y completo da el secreto y, si se fija, el usuario de integración', () => {
    expect(configWebhookDesdeEnv(ok)).toEqual({ config: { secreto: 's' } });
    expect(configWebhookDesdeEnv({ ...ok, CAPTACION_INTEGRATION_USER_ID: ' 42 ' })).toEqual({ config: { secreto: 's', usuarioIntegracionId: '42' } });
  });
});
