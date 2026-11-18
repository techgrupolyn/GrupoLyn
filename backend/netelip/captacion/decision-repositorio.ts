import {
  calcularAcierto, compararDecisiones, DECISIONES, EntradaInvalida, ETIQUETA_DECISION, motivoDeEscalado, requiereAFavor, validarEntradaDecision,
  validarPasosEditados, type Actor, type CasoRevisado, type Decision, type DecisionIA, type EntradaDecision, type EstadoValidacion,
  type FilaAcierto, type MotivoEscalado, type MotivosPorDecision, type Origen, type ProximoPaso,
} from './decision.ts';
import { bloquearLead, cargarResumenVigente, enTransaccion, type Db } from './repositorio.ts';
import type { ResumenLead } from './resumen.ts';

// N-1.4 · Capa de datos de la decisión de pase. Guarda lo que decide la lógica pura (decision.ts); no escribe en ClickUp ni mueve
// fases. Las operaciones que abren una transacción necesitan UNA conexión (un cliente de pg, no el pool).

const texto = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const jsonb = (v: unknown): string => JSON.stringify(v);

export class LlamadaSinLead extends Error {}
export class YaRegistrada extends Error {}
export class CasoNoEncontrado extends Error {}
export class CasoYaRevisado extends Error {}

/** Id de la interacción de una llamada de Netelip en las tablas de la captación. */
export const llamadaIdDe = (idLlamada: number | string): string => `netelip:${idLlamada}`;

// ---------------------------------------------------------------------------------------------
// Configuración vigente: motivos y contexto de la IA
// ---------------------------------------------------------------------------------------------

/** Lista de motivos de la versión más reciente. Siempre trae las cuatro decisiones (vacías si no tienen motivos). */
export async function cargarMotivos(db: Db): Promise<MotivosPorDecision> {
  const r = await db.query(
    `SELECT decision, codigo, etiqueta FROM decision_motivo_config
     WHERE version = (SELECT max(version) FROM decision_motivo_config) ORDER BY decision, orden`,
  );
  const lista: Record<Decision, Array<{ codigo: string; etiqueta: string }>> = { pasar_a_reunion: [], derivar_partners: [], seguimiento: [], descartar: [] };
  for (const f of r.rows) lista[f.decision as Decision]?.push({ codigo: String(f.codigo), etiqueta: String(f.etiqueta) });
  return lista;
}

export interface ContextoIA {
  guion: { version: number; texto: string };
  manual: { version: number; texto: string };
}

/** Guion del SDR y manual de reglas vigentes (la mayor versión de cada tipo). Falla si falta alguno. */
export async function cargarContexto(db: Db): Promise<ContextoIA> {
  const r = await db.query('SELECT DISTINCT ON (tipo) tipo, version, texto FROM decision_contexto_config ORDER BY tipo, version DESC');
  const por = Object.fromEntries(r.rows.map((f) => [String(f.tipo), { version: Number(f.version), texto: String(f.texto) }]));
  if (!por.guion || !por.manual) throw new Error('Falta el guion o el manual de reglas de la decisión de pase');
  return { guion: por.guion, manual: por.manual };
}

// ---------------------------------------------------------------------------------------------
// Filas de decisión
// ---------------------------------------------------------------------------------------------

export interface FilaDecision {
  leadId: string;
  llamadaId: string;
  actor: Actor;
  decision: Decision;
  motivoCodigo: string | null;
  motivoTexto: string | null;
  datoCita: string | null;
  motivos: unknown[];
  excepciones: string[];
  dudas: string[];
  pendienteErnesto: { queDebeDecidir: string } | null;
  proximosPasos: ProximoPaso[];
  versionGuion: number | null;
  versionManual: number | null;
  versionPrompt: string | null;
  origen: Origen;
  aFavor: 'sdr' | 'ia' | null;
  usuarioId: string | null;
  usuarioNombre: string | null;
  creadoEn: string;
}

const COLUMNAS = `lead_id, llamada_id, actor, decision, motivo_codigo, motivo_texto, dato_cita, motivos, excepciones, dudas, pendiente_ernesto,
  proximos_pasos, version_guion, version_manual, version_prompt, origen, a_favor, usuario_id, usuario_nombre, creado_en`;

function aFila(f: Record<string, unknown>): FilaDecision {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    leadId: String(f.lead_id), llamadaId: String(f.llamada_id), actor: f.actor as Actor, decision: f.decision as Decision,
    motivoCodigo: texto(f.motivo_codigo), motivoTexto: texto(f.motivo_texto), datoCita: texto(f.dato_cita),
    motivos: (f.motivos as unknown[]) ?? [], excepciones: (f.excepciones as string[]) ?? [], dudas: (f.dudas as string[]) ?? [],
    pendienteErnesto: (f.pendiente_ernesto as FilaDecision['pendienteErnesto']) ?? null,
    proximosPasos: (f.proximos_pasos as ProximoPaso[]) ?? [],
    versionGuion: num(f.version_guion), versionManual: num(f.version_manual), versionPrompt: texto(f.version_prompt),
    origen: f.origen as Origen, aFavor: (f.a_favor as FilaDecision['aFavor']) ?? null, usuarioId: texto(f.usuario_id), usuarioNombre: texto(f.usuario_nombre),
    creadoEn: iso(f.creado_en),
  };
}

async function filasDeLlamada(db: Db, llamadaId: string): Promise<Partial<Record<Actor, FilaDecision>>> {
  const r = await db.query(`SELECT ${COLUMNAS} FROM decision_lead WHERE llamada_id = $1`, [llamadaId]);
  return Object.fromEntries(r.rows.map((f) => [String(f.actor), aFila(f)]));
}

/** Lead (tarea de ClickUp) al que la captación vinculó esa llamada, o null si aún no se procesó. */
export async function leadDeLlamada(db: Db, llamadaId: string): Promise<string | null> {
  const r = await db.query('SELECT clickup_task_id FROM lead_criterio_evaluacion WHERE interaccion_id = $1 LIMIT 1', [llamadaId]);
  return r.rows[0] ? String(r.rows[0].clickup_task_id) : null;
}

// ---------------------------------------------------------------------------------------------
// Decisión de la IA
// ---------------------------------------------------------------------------------------------

export interface RegistroDecisionIA {
  leadId: string;
  llamadaId: string;
  decision: DecisionIA;
  versionGuion: number;
  versionManual: number;
  versionPrompt: string;
  /** `nuevo` entra en el piloto (bandeja y acierto); `historico` es de la calibración y no cuenta para nada de eso. */
  origen: Origen;
}

/** Guarda la decisión de la IA de una llamada (una por llamada: repetir no la cambia). Devuelve false si ya estaba. */
export async function registrarDecisionIA(db: Db, r: RegistroDecisionIA): Promise<boolean> {
  const principal = r.decision.motivos[0];
  const res = await db.query(
    `INSERT INTO decision_lead
       (lead_id, llamada_id, actor, decision, motivo_codigo, motivo_texto, dato_cita, motivos, excepciones, dudas, pendiente_ernesto,
        proximos_pasos, version_guion, version_manual, version_prompt, origen)
     VALUES ($1, $2, 'ia', $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15)
     ON CONFLICT (llamada_id, actor) DO NOTHING
     RETURNING id`,
    [
      r.leadId, r.llamadaId, r.decision.decision, principal?.codigo ?? null, principal?.texto ?? null, principal?.cita ?? null,
      jsonb(r.decision.motivos), jsonb(r.decision.excepciones), jsonb(r.decision.dudas), r.decision.pendienteErnesto ? jsonb(r.decision.pendienteErnesto) : null,
      jsonb(r.decision.proximosPasos), r.versionGuion, r.versionManual, r.versionPrompt, r.origen,
    ],
  );
  const nueva = res.rows.length > 0;
  if (nueva) await reconciliarValidacion(db, r.llamadaId);
  return nueva;
}

/**
 * Cuando existen la propuesta del SDR Y la decisión de la IA de una llamada, crea el caso para Ernesto con su motivo de escalado.
 * Si ya existe no lo toca. Devuelve el motivo de escalado del caso (el nuevo o el que ya había), o null si aún falta una de las dos.
 */
export async function reconciliarValidacion(db: Db, llamadaId: string): Promise<MotivoEscalado | null> {
  const previa = await db.query('SELECT motivo_escalado FROM validacion_decision WHERE llamada_id = $1', [llamadaId]);
  if (previa.rows[0]) return previa.rows[0].motivo_escalado as MotivoEscalado;
  const f = await filasDeLlamada(db, llamadaId);
  if (!f.sdr || !f.ia || f.ia.origen !== 'nuevo') return null;
  const cmp = compararDecisiones({ decision: f.sdr.decision, motivoCodigo: f.sdr.motivoCodigo }, { decision: f.ia.decision, motivoCodigo: f.ia.motivoCodigo });
  const motivo = motivoDeEscalado(cmp.coincide, { excepciones: f.ia.excepciones as never, dudas: f.ia.dudas as never, pendienteErnesto: f.ia.pendienteErnesto, proximosPasos: f.ia.proximosPasos });
  await db.query(
    `INSERT INTO validacion_decision (llamada_id, lead_id, coincidencia_sdr_ia, motivo_escalado) VALUES ($1, $2, $3, $4)
     ON CONFLICT (llamada_id) DO NOTHING`,
    [llamadaId, f.sdr.leadId, cmp.coincide, motivo],
  );
  return motivo;
}

// ---------------------------------------------------------------------------------------------
// Propuesta del SDR
// ---------------------------------------------------------------------------------------------

export interface RegistroSDR {
  llamadaId: string;
  entrada: EntradaDecision;
  usuarioId: string;
  usuarioNombre: string;
}

/**
 * El SDR registra su propuesta, UNA vez por llamada (su valoración debe seguir siendo independiente de la de la IA). La llamada tiene
 * que estar procesada (con su lead identificado). `db` es una conexión: abre una transacción y bloquea el lead.
 */
export async function registrarPropuestaSDR(db: Db, r: RegistroSDR): Promise<{ leadId: string; motivoEscalado: MotivoEscalado | null }> {
  const leadId = await leadDeLlamada(db, r.llamadaId);
  if (leadId === null) throw new LlamadaSinLead('La llamada todavía no está vinculada a un lead.');
  return enTransaccion(db, async () => {
    await bloquearLead(db, leadId);
    const res = await db.query(
      `INSERT INTO decision_lead (lead_id, llamada_id, actor, decision, motivo_codigo, motivo_texto, dato_cita, usuario_id, usuario_nombre)
       VALUES ($1, $2, 'sdr', $3, $4, $5, $6, $7, $8)
       ON CONFLICT (llamada_id, actor) DO NOTHING
       RETURNING id`,
      [leadId, r.llamadaId, r.entrada.decision, r.entrada.motivoCodigo, r.entrada.motivoTexto, r.entrada.datoCita, r.usuarioId, r.usuarioNombre],
    );
    if (res.rows.length === 0) throw new YaRegistrada('La propuesta de esta llamada ya está registrada.');
    return { leadId, motivoEscalado: await reconciliarValidacion(db, r.llamadaId) };
  });
}

export interface VistaSDR {
  leadConocido: boolean;
  sdr: FilaDecision | null;
  /** La decisión de la IA y sus próximos pasos, SOLO después de que el SDR registre la suya. */
  ia: FilaDecision | null;
  estado: EstadoValidacion | null;
  motivos: MotivosPorDecision;
}

/** Lo que ve el SDR en el detalle de una llamada: su propuesta, la lista de motivos y, solo después de decidir, la de la IA. */
export async function vistaParaSDR(db: Db, llamadaId: string): Promise<VistaSDR> {
  // Consultas en serie: es una sola conexión.
  const leadId = await leadDeLlamada(db, llamadaId);
  const motivos = await cargarMotivos(db);
  const f = await filasDeLlamada(db, llamadaId);
  const sdr = f.sdr ?? null;
  let estado: EstadoValidacion | null = null;
  if (sdr) {
    const v = await db.query('SELECT estado FROM validacion_decision WHERE llamada_id = $1', [llamadaId]);
    estado = (v.rows[0]?.estado as EstadoValidacion | undefined) ?? null;
  }
  return { leadConocido: leadId !== null, sdr, ia: sdr ? (f.ia ?? null) : null, estado, motivos };
}

// ---------------------------------------------------------------------------------------------
// Bandeja de Ernesto
// ---------------------------------------------------------------------------------------------

export interface FilaBandeja {
  llamadaId: string;
  leadId: string;
  fechaLlamada: string | null;
  sdr: { decision: Decision; motivoCodigo: string | null };
  ia: { decision: Decision; motivoCodigo: string | null };
  coincide: boolean;
  motivoEscalado: MotivoEscalado;
  estado: EstadoValidacion;
  /** Desde cuándo espera el caso (creación del caso, o su revisión si ya está revisado). */
  creadoEn: string;
  revisadoEn: string | null;
}

/** Una fila por caso: los pendientes primero y los más antiguos antes. */
export async function bandeja(db: Db, o: { estado?: 'pendientes' | 'revisados' | 'todos'; limite?: number } = {}): Promise<FilaBandeja[]> {
  const filtro = o.estado === 'revisados' ? "v.estado <> 'pendiente_ernesto'" : o.estado === 'todos' ? 'true' : "v.estado = 'pendiente_ernesto'";
  const limite = Number.isSafeInteger(o.limite) && (o.limite as number) > 0 ? Math.min(o.limite as number, 500) : 200;
  const r = await db.query(
    `SELECT v.llamada_id, v.lead_id, v.coincidencia_sdr_ia, v.motivo_escalado, v.estado, v.creado_en, v.revisado_en,
            s.decision AS sdr_decision, s.motivo_codigo AS sdr_motivo, i.decision AS ia_decision, i.motivo_codigo AS ia_motivo,
            (SELECT min(e.fecha_interaccion) FROM lead_criterio_evaluacion e WHERE e.interaccion_id = v.llamada_id) AS fecha_llamada
     FROM validacion_decision v
     JOIN decision_lead s ON s.llamada_id = v.llamada_id AND s.actor = 'sdr'
     JOIN decision_lead i ON i.llamada_id = v.llamada_id AND i.actor = 'ia'
     WHERE ${filtro}
     ORDER BY (v.estado = 'pendiente_ernesto') DESC, v.creado_en ASC, v.llamada_id
     LIMIT $1`,
    [limite],
  );
  return r.rows.map((f) => ({
    llamadaId: String(f.llamada_id), leadId: String(f.lead_id), fechaLlamada: f.fecha_llamada ? iso(f.fecha_llamada) : null,
    sdr: { decision: f.sdr_decision as Decision, motivoCodigo: texto(f.sdr_motivo) }, ia: { decision: f.ia_decision as Decision, motivoCodigo: texto(f.ia_motivo) },
    coincide: Boolean(f.coincidencia_sdr_ia), motivoEscalado: f.motivo_escalado as MotivoEscalado, estado: f.estado as EstadoValidacion,
    creadoEn: iso(f.creado_en), revisadoEn: f.revisado_en ? iso(f.revisado_en) : null,
  }));
}

export interface DetalleCaso {
  llamadaId: string;
  leadId: string;
  estado: EstadoValidacion;
  motivoEscalado: MotivoEscalado;
  coincide: boolean;
  revisadoPor: string | null;
  revisadoEn: string | null;
  sdr: FilaDecision;
  ia: FilaDecision;
  ernesto: FilaDecision | null;
  /** Resumen ejecutivo vigente del lead (N-1.3). */
  resumen: ResumenLead | null;
  /** Última calificación del lead (categoría, presupuesto y ponderado). */
  calificacion: { categoria: string; presupuesto: number | null; ponderado: number | null } | null;
  motivos: MotivosPorDecision;
}

export async function detalleCaso(db: Db, llamadaId: string): Promise<DetalleCaso | null> {
  const v = await db.query('SELECT * FROM validacion_decision WHERE llamada_id = $1', [llamadaId]);
  const caso = v.rows[0];
  if (!caso) return null;
  const f = await filasDeLlamada(db, llamadaId);
  if (!f.sdr || !f.ia) return null;
  const leadId = String(caso.lead_id);
  const cal = await db.query(
    'SELECT categoria, presupuesto_vigente::float8 AS presupuesto, ponderado::float8 AS ponderado FROM lead_calificacion_historial WHERE clickup_task_id = $1 ORDER BY seq DESC LIMIT 1',
    [leadId],
  );
  const c = cal.rows[0];
  return {
    llamadaId, leadId, estado: caso.estado as EstadoValidacion, motivoEscalado: caso.motivo_escalado as MotivoEscalado, coincide: Boolean(caso.coincidencia_sdr_ia),
    revisadoPor: texto(caso.revisado_por), revisadoEn: caso.revisado_en ? iso(caso.revisado_en) : null,
    sdr: f.sdr, ia: f.ia, ernesto: f.ernesto ?? null,
    resumen: await cargarResumenVigente(db, leadId),
    calificacion: c ? { categoria: String(c.categoria), presupuesto: c.presupuesto === null ? null : Number(c.presupuesto), ponderado: c.ponderado === null ? null : Number(c.ponderado) } : null,
    motivos: await cargarMotivos(db),
  };
}

// ---------------------------------------------------------------------------------------------
// Confirmar y corregir (Ernesto)
// ---------------------------------------------------------------------------------------------

export interface Revisor {
  usuarioId: string;
  usuarioNombre: string;
}

/** Bloquea el caso y comprueba que sigue pendiente; devuelve las propuestas del SDR y de la IA. */
async function casoPendiente(db: Db, llamadaId: string): Promise<{ leadId: string; sdr: FilaDecision; ia: FilaDecision }> {
  const v = await db.query('SELECT lead_id, estado FROM validacion_decision WHERE llamada_id = $1 FOR UPDATE', [llamadaId]);
  if (!v.rows[0]) throw new CasoNoEncontrado('No existe ese caso en la bandeja.');
  if (v.rows[0].estado !== 'pendiente_ernesto') throw new CasoYaRevisado('Ese caso ya está revisado.');
  const f = await filasDeLlamada(db, llamadaId);
  if (!f.sdr || !f.ia) throw new CasoNoEncontrado('Al caso le falta la propuesta del SDR o la decisión de la IA.');
  return { leadId: String(v.rows[0].lead_id), sdr: f.sdr, ia: f.ia };
}

async function guardarRevision(
  db: Db,
  a: { llamadaId: string; leadId: string; revisor: Revisor; estado: 'validada' | 'corregida'; decision: Decision; motivoCodigo: string | null; motivoTexto: string | null; datoCita: string; pasos: ProximoPaso[]; aFavor: 'sdr' | 'ia' | null; ia: FilaDecision },
): Promise<void> {
  await db.query(
    `INSERT INTO decision_lead
       (lead_id, llamada_id, actor, decision, motivo_codigo, motivo_texto, dato_cita, proximos_pasos, version_guion, version_manual, version_prompt, a_favor, usuario_id, usuario_nombre)
     VALUES ($1, $2, 'ernesto', $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13)`,
    [a.leadId, a.llamadaId, a.decision, a.motivoCodigo, a.motivoTexto, a.datoCita, jsonb(a.pasos), a.ia.versionGuion, a.ia.versionManual, a.ia.versionPrompt, a.aFavor, a.revisor.usuarioId, a.revisor.usuarioNombre],
  );
  await db.query(
    "UPDATE validacion_decision SET estado = $2, revisado_por = $3, revisado_en = now() WHERE llamada_id = $1",
    [a.llamadaId, a.estado, a.revisor.usuarioId],
  );
}

/**
 * Ernesto confirma. Si SDR e IA coinciden en decisión y motivo no hace falta nada más; si no, tiene que decir con quién está de acuerdo
 * (`aFavor`) y se adopta su decisión y su motivo. Queda guardada su fila (la decisión final) junto a las del SDR y la IA.
 */
export async function confirmarCaso(db: Db, a: { llamadaId: string; revisor: Revisor; aFavor?: string | null }): Promise<FilaDecision> {
  return enTransaccion(db, async () => {
    const { leadId, sdr, ia } = await casoPendiente(db, a.llamadaId);
    const cmp = compararDecisiones({ decision: sdr.decision, motivoCodigo: sdr.motivoCodigo }, { decision: ia.decision, motivoCodigo: ia.motivoCodigo });
    const aFavor = a.aFavor === undefined || a.aFavor === null || a.aFavor === '' ? null : a.aFavor;
    if (aFavor !== null && aFavor !== 'sdr' && aFavor !== 'ia') throw new EntradaInvalida('«a favor» debe ser sdr o ia.');
    if (requiereAFavor(cmp) && aFavor === null) throw new EntradaInvalida('SDR e IA no coinciden en decisión y motivo: indica con quién estás de acuerdo (sdr o ia).');
    const elegida = aFavor === 'sdr' ? sdr : ia;
    await guardarRevision(db, {
      llamadaId: a.llamadaId, leadId, revisor: a.revisor, estado: 'validada', decision: elegida.decision, motivoCodigo: elegida.motivoCodigo, motivoTexto: elegida.motivoTexto,
      datoCita: elegida.datoCita ?? 'Confirmado sin cambios', pasos: ia.proximosPasos, aFavor, ia,
    });
    return (await filasDeLlamada(db, a.llamadaId)).ernesto as FilaDecision;
  });
}

/**
 * Ernesto corrige: decisión, motivo y el dato que cambia su criterio son obligatorios (sin ellos no se guarda nada). Puede editar los
 * próximos pasos; si no manda ninguno, quedan los de la IA.
 */
export async function corregirCaso(db: Db, a: { llamadaId: string; revisor: Revisor; entrada: unknown; proximosPasos?: unknown }): Promise<FilaDecision> {
  const motivos = await cargarMotivos(db);
  const entrada = validarEntradaDecision(a.entrada, motivos);
  const pasosEditados = validarPasosEditados(a.proximosPasos);
  return enTransaccion(db, async () => {
    const { leadId, ia } = await casoPendiente(db, a.llamadaId);
    await guardarRevision(db, {
      llamadaId: a.llamadaId, leadId, revisor: a.revisor, estado: 'corregida', decision: entrada.decision, motivoCodigo: entrada.motivoCodigo, motivoTexto: entrada.motivoTexto,
      datoCita: entrada.datoCita, pasos: a.proximosPasos === undefined || a.proximosPasos === null ? ia.proximosPasos : pasosEditados, aFavor: null, ia,
    });
    return (await filasDeLlamada(db, a.llamadaId)).ernesto as FilaDecision;
  });
}

// ---------------------------------------------------------------------------------------------
// Acierto y decisión final
// ---------------------------------------------------------------------------------------------

/** Acierto del piloto: solo casos nuevos revisados por Ernesto (los históricos de la calibración no tienen caso ni suman). */
export async function acierto(db: Db): Promise<FilaAcierto[]> {
  const r = await db.query(
    `SELECT v.estado, v.coincidencia_sdr_ia, s.decision AS s_d, s.motivo_codigo AS s_m, i.decision AS i_d, i.motivo_codigo AS i_m, i.origen,
            e.decision AS e_d, e.motivo_codigo AS e_m
     FROM validacion_decision v
     JOIN decision_lead s ON s.llamada_id = v.llamada_id AND s.actor = 'sdr'
     JOIN decision_lead i ON i.llamada_id = v.llamada_id AND i.actor = 'ia'
     LEFT JOIN decision_lead e ON e.llamada_id = v.llamada_id AND e.actor = 'ernesto'`,
  );
  const casos: CasoRevisado[] = r.rows.map((f) => ({
    origen: f.origen as Origen, estado: f.estado as EstadoValidacion, coincide: Boolean(f.coincidencia_sdr_ia),
    sdr: { decision: f.s_d as Decision, motivoCodigo: texto(f.s_m) }, ia: { decision: f.i_d as Decision, motivoCodigo: texto(f.i_m) },
    final: f.e_d ? { decision: f.e_d as Decision, motivoCodigo: texto(f.e_m) } : null,
  }));
  return calcularAcierto(casos);
}

/** La decisión final más reciente de un lead («Pase: Seguimiento · Ernesto»), para reflejarla en su tarjeta; null si ninguna se revisó aún. */
export async function decisionFinalDelLead(db: Db, leadId: string): Promise<string | null> {
  const r = await db.query(
    "SELECT decision, usuario_nombre FROM decision_lead WHERE lead_id = $1 AND actor = 'ernesto' ORDER BY seq DESC LIMIT 1",
    [leadId],
  );
  const f = r.rows[0];
  if (!f) return null;
  return `${ETIQUETA_DECISION[f.decision as Decision] ?? String(f.decision)} · ${texto(f.usuario_nombre) ?? 'Ernesto'}`;
}

/** Para comprobar en pruebas y rutas que una decisión es de las cuatro. */
export const esDecision = (v: unknown): v is Decision => typeof v === 'string' && (DECISIONES as readonly string[]).includes(v);
