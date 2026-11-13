// ClickUp falso para las pruebas: un servidor HTTP local que responde como la API v2 (campos, tareas
// paginadas y escritura de campos) y apunta cada petición. Nunca se llama al ClickUp real.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const LISTA_FALSA = '901211441576';
export const TOKEN_FALSO = 'pk_token_de_prueba_123';

export interface PeticionFalsa { metodo: string; ruta: string; auth: string | undefined; cuerpo: unknown }

const opciones = (nombres: string[], prefijo: string) => nombres.map((name, i) => ({ id: `${prefijo}-${i}`, name, orderindex: i }));

export const CAMPOS_FALSOS = [
  { id: 'f-cat', name: 'valoracion_interna', type: 'drop_down', type_config: { options: opciones(['A+', 'A', 'B', 'C', 'D', 'Sin calificar', 'No apto'], 'o-cat') } },
  { id: 'f-pres', name: 'presupuesto_estimado', type: 'currency', type_config: {} },
  { id: 'f-pond', name: 'valor_del_negocio', type: 'currency', type_config: {} },
  { id: 'f-fuente', name: 'Fuente del presupuesto', type: 'drop_down', type_config: { options: opciones(['Formulario', 'Llamada', 'Reunión', 'WhatsApp', 'Fase 2 LYN', 'Manual', 'Pendiente: preguntar en la 1ª llamada'], 'o-fuente') } },
  { id: 'f-desg', name: 'Desglose de calificación', type: 'short_text', type_config: {} },
  { id: 'f-tel', name: 'contact_phone_number', type: 'phone', type_config: {} },
  { id: 'f-mail', name: 'email', type: 'email', type_config: {} },
  { id: 'f-etapa', name: 'ETAPA_CRM', type: 'drop_down', type_config: { options: opciones(['e1. EN ESPERA', 'e3. VIABILIDAD', 'e4. VISITA', 'e16. RECHAZADO', 'e15. PERDIDO'], 'o-etapa') } },
  { id: 'f-tcon', name: 'Tipo de Contacto', type: 'drop_down', type_config: { options: opciones(['Reforma_integral_de_vivienda', 'Reforma_global_de_vivienda_(salvo_algunas_estancias)', 'REFORMA'], 'o-tcon') } },
  { id: 'f-tref', name: 'tipo_reforma', type: 'drop_down', type_config: { options: opciones(['Integral', 'Parcial'], 'o-tref') } },
  { id: 'f-indice', name: 'Índice de orden', type: 'number', type_config: {} },
];

export interface TareaFalsa {
  id: string;
  nombre: string;
  telefono?: string;
  email?: string;
  /** Posición en las opciones de ETAPA_CRM (0 = e1. EN ESPERA, 1 = e3. VIABILIDAD, 2 = e4. VISITA, 3 = e16. RECHAZADO, 4 = e15. PERDIDO). */
  etapa: number;
  tipoContacto?: number;
  /** Posición en las opciones de tipo_reforma (0 = Integral, 1 = Parcial). */
  tipoReforma?: number;
  /** Id de la tarea padre: es una subtarea. */
  padre?: string;
  cerrada?: boolean;
}

const campo = (nombre: string, valor: unknown) => {
  const def = CAMPOS_FALSOS.find((c) => c.name === nombre)!;
  return { id: def.id, name: def.name, type: def.type, type_config: def.type_config, value: valor };
};

export function aTareaClickUp(t: TareaFalsa): Record<string, unknown> {
  const cf = [campo('ETAPA_CRM', t.etapa)];
  if (t.telefono) cf.push(campo('contact_phone_number', t.telefono));
  if (t.email) cf.push(campo('email', t.email));
  if (t.tipoContacto !== undefined) cf.push(campo('Tipo de Contacto', t.tipoContacto));
  if (t.tipoReforma !== undefined) cf.push(campo('tipo_reforma', t.tipoReforma));
  return {
    id: t.id, name: t.nombre, date_created: '1762000000000', ...(t.padre ? { parent: t.padre } : {}),
    status: { status: t.cerrada ? 'perdido' : 'en curso', type: t.cerrada ? 'closed' : 'open' },
    custom_fields: cf,
  };
}

export interface ClickUpFalso {
  base: string;
  peticiones: PeticionFalsa[];
  tareas: TareaFalsa[];
  campos: typeof CAMPOS_FALSOS;
  /** Si devuelve true para una petición, el servidor falso contesta 404 (no se reintenta). */
  fallar: ((p: PeticionFalsa) => boolean) | null;
  cerrar: () => Promise<void>;
}

export async function levantarClickUpFalso(): Promise<ClickUpFalso> {
  const falso = { peticiones: [] as PeticionFalsa[], tareas: [] as TareaFalsa[], campos: [...CAMPOS_FALSOS], fallar: null as ClickUpFalso['fallar'] };
  const servidor: Server = createServer((req, res) => {
    const trozos: Buffer[] = [];
    req.on('data', (t) => trozos.push(t));
    req.on('end', () => {
      const texto = Buffer.concat(trozos).toString('utf8');
      const peticion: PeticionFalsa = { metodo: req.method ?? '', ruta: req.url ?? '', auth: req.headers.authorization, cuerpo: texto ? JSON.parse(texto) : undefined };
      falso.peticiones.push(peticion);
      const url = new URL(req.url ?? '/', 'http://x');
      if (falso.fallar?.(peticion)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'GET' && url.pathname === `/list/${LISTA_FALSA}/field`) res.end(JSON.stringify({ fields: falso.campos }));
      else if (req.method === 'GET' && url.pathname === `/list/${LISTA_FALSA}/task`) {
        const pagina = Number(url.searchParams.get('page'));
        res.end(JSON.stringify({ tasks: falso.tareas.slice(pagina * 100, pagina * 100 + 100).map(aTareaClickUp) }));
      } else res.end('{}');
    });
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  return {
    base: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`,
    get peticiones() { return falso.peticiones; },
    get tareas() { return falso.tareas; },
    set tareas(v) { falso.tareas = v; },
    get campos() { return falso.campos; },
    set campos(v) { falso.campos = v; },
    get fallar() { return falso.fallar; },
    set fallar(v) { falso.fallar = v; },
    cerrar: () => new Promise<void>((ok) => servidor.close(() => ok())),
  } as ClickUpFalso;
}
