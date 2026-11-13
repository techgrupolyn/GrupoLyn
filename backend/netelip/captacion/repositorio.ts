import {
  calcularCategoria,
  nivelesVigentes,
  noAptoVigente,
  type EvaluacionCriterio,
  type EventoNoApto,
  type ResultadoAgregacion,
} from './agregacion.ts';
import { CRITERIOS_IDS, type AgregacionConfig, type CriterioConfig, type CriterioId, type Nivel, type NivelONE } from './matriz.ts';
import {
  calificar,
  presupuestoDelFormulario,
  presupuestoVigente,
  validarEscrituras,
  valorVigenteDe,
  type Calificacion,
  type Disparador,
  type EstadoPrevio,
} from './motor.ts';
import { SalidaInvalida, validarSalidaModelo, verificarSalida, type SalidaVerificada } from './salida-modelo.ts';
import { CATEGORIAS, type Categoria, type ConfigCategoria, type EventoPresupuesto, type Fuente } from './tipos.ts';

// Capa de datos de N-1.1 y N-1.2: guarda lo que decide la lógica pura y lee el estado de un lead.
// No escribe en ClickUp: devuelve el payload (`escrituras`) para que lo envíe el cliente de ClickUp.
// Funciona con un cliente de `pg` o con PGlite (solo necesita `query`).

export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const texto = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/**
 * Ejecuta `fn` en una transacción. `db` debe ser UNA conexión (un cliente de pg, no el pool: cada
 * consulta del pool podría ir a una conexión distinta y el BEGIN no abarcaría nada).
 */
export async function enTransaccion<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    const resultado = await fn();
    await db.query('COMMIT');
    return resultado;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Configuración vigente
// ---------------------------------------------------------------------------------------------

export interface ConfigVigente {
  categorias: ConfigCategoria[];
  matriz: CriterioConfig[];
  agregacion: AgregacionConfig;
  /**
   * Identifica el estado de la configuración: el mayor número de versión de las tres tablas. Para
   * publicar un cambio se insertan las filas nuevas con «mayor versión existente + 1» en la tabla que cambia.
   */
  version: number;
}

/** Lee la versión más reciente de cada tabla de configuración. Falla si alguna está incompleta. */
export async function cargarConfig(db: Db): Promise<ConfigVigente> {
  const cat = await db.query(
    `SELECT categoria, valor_ponderado::float8 AS valor_ponderado, orden, version
     FROM categoria_config WHERE version = (SELECT max(version) FROM categoria_config) ORDER BY orden`,
  );
  const cri = await db.query(
    `SELECT criterio_id, nombre, etiqueta, peso, descriptor_a, descriptor_b, descriptor_c, descriptor_d, orden, version
     FROM criterio_config WHERE version = (SELECT max(version) FROM criterio_config) ORDER BY orden`,
  );
  const agr = await db.query(
    `SELECT version, puntos_a, puntos_b, puntos_c, puntos_d, corte_a::float8 AS corte_a, corte_b::float8 AS corte_b,
            corte_c::float8 AS corte_c, cobertura_minima::float8 AS cobertura_minima, umbral_a_plus::float8 AS umbral_a_plus
     FROM agregacion_config ORDER BY version DESC LIMIT 1`,
  );
  const a = agr.rows[0];
  if (cat.rows.length !== CATEGORIAS.length || cri.rows.length !== CRITERIOS_IDS.length || !a) {
    throw new Error(
      `Configuración incompleta: ${cat.rows.length} categorías, ${cri.rows.length} criterios, ${agr.rows.length} agregación`,
    );
  }
  return {
    categorias: cat.rows.map((f) => ({
      categoria: f.categoria as Categoria,
      valorPonderado: num(f.valor_ponderado),
      orden: Number(f.orden),
    })),
    matriz: cri.rows.map((f) => ({
      criterioId: f.criterio_id as CriterioId,
      nombre: String(f.nombre),
      etiqueta: String(f.etiqueta),
      peso: Number(f.peso),
      descriptores: { A: String(f.descriptor_a), B: String(f.descriptor_b), C: String(f.descriptor_c), D: String(f.descriptor_d) },
      orden: Number(f.orden),
    })),
    agregacion: {
      puntos: { A: Number(a.puntos_a), B: Number(a.puntos_b), C: Number(a.puntos_c), D: Number(a.puntos_d) },
      corteA: Number(a.corte_a),
      corteB: Number(a.corte_b),
      corteC: Number(a.corte_c),
      coberturaMinima: Number(a.cobertura_minima),
      umbralAPlus: Number(a.umbral_a_plus),
      version: Number(a.version),
    },
    version: Math.max(Number(cat.rows[0]?.version), Number(cri.rows[0]?.version), Number(a.version)),
  };
}

// ---------------------------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------------------------

export interface RegistroEvaluacion {
  clickupTaskId: string;
  /** Id de la llamada (el mismo `interaccion_id` que devolvió el modelo). */
  interaccionId: string;
  /** Cuándo ocurrió la llamada (no cuándo se procesó): manda esta fecha. */
  fechaInteraccion: string;
  verificada: SalidaVerificada;
}

export interface ResultadoRegistro {
  criterios: number;
  presupuesto: boolean;
  noApto: boolean;
  revisionManual: string[];
}

/**
 * Guarda lo que vale de una evaluación: 7 filas de criterio, el presupuesto (si hay) y el evento de
 * No apto (si lo marca o lo levanta con cita). Idempotente: repetir la misma interacción no duplica nada.
 */
export async function registrarEvaluacionLlamada(db: Db, r: RegistroEvaluacion): Promise<ResultadoRegistro> {
  let criterios = 0;
  for (const id of CRITERIOS_IDS) {
    const c = r.verificada.criterios[id];
    const res = await db.query(
      `INSERT INTO lead_criterio_evaluacion
         (clickup_task_id, criterio_id, nivel, plazo_meses, origen, cita, marca_tiempo, interaccion_id, fecha_interaccion)
       VALUES ($1, $2, $3, $4, 'llamada', $5, $6, $7, $8)
       ON CONFLICT (interaccion_id, criterio_id) DO NOTHING
       RETURNING id`,
      [r.clickupTaskId, id, c.nivel, c.plazoMeses, c.cita, c.marcaTiempo, r.interaccionId, r.fechaInteraccion],
    );
    criterios += res.rows.length;
  }

  const revisionManual = [...r.verificada.revisionManual];
  let presupuesto = false;
  const p = r.verificada.presupuesto;
  if (p) {
    let valor: number | null = null;
    try {
      valor = valorVigenteDe({ tipo: p.tipo, valorMin: p.min, valorMax: p.max });
    } catch (error) {
      // Rango abierto («más de X»): la regla del valor vigente está pendiente (P-04). Lo revisa una persona.
      revisionManual.push(`presupuesto ${p.tipo}: ${(error as Error).message}`);
    }
    if (valor !== null) {
      const res = await db.query(
        `INSERT INTO lead_presupuesto_evento
           (clickup_task_id, fuente, tipo, valor_min, valor_max, valor_vigente, moneda, emisor, cita_textual,
            interaccion_id, fecha_interaccion, registrado_por)
         VALUES ($1, 'llamada_netelip', $2, $3, $4, $5, 'EUR', $6, $7, $8, $9, 'ia')
         ON CONFLICT ON CONSTRAINT lead_presupuesto_evento_interaccion_uq DO NOTHING
         RETURNING id`,
        [r.clickupTaskId, p.tipo, p.min, p.max, valor, p.emisor, p.cita, r.interaccionId, r.fechaInteraccion],
      );
      presupuesto = res.rows.length > 0;
    }
  }

  let noApto = false;
  const n = r.verificada.noApto;
  if (n.cita !== null) {
    const res = await db.query(
      `INSERT INTO lead_no_apto_evento (clickup_task_id, valor, cita, interaccion_id, fecha_interaccion, registrado_por)
       VALUES ($1, $2, $3, $4, $5, 'ia')
       ON CONFLICT (interaccion_id) DO NOTHING
       RETURNING id`,
      [r.clickupTaskId, n.valor, n.cita, r.interaccionId, r.fechaInteraccion],
    );
    noApto = res.rows.length > 0;
  }
  return { criterios, presupuesto, noApto, revisionManual };
}

/** Nivel provisional de Alcance desde el formulario. Un solo registro por lead; si es NE no se guarda. */
export async function registrarAlcanceProvisional(
  db: Db,
  datos: { clickupTaskId: string; nivel: NivelONE; fechaInteraccion: string },
): Promise<boolean> {
  if (datos.nivel === 'NE') return false;
  const res = await db.query(
    `INSERT INTO lead_criterio_evaluacion (clickup_task_id, criterio_id, nivel, origen, fecha_interaccion)
     VALUES ($1, 'alcance', $2, 'formulario_provisional', $3)
     ON CONFLICT (clickup_task_id, criterio_id) WHERE origen = 'formulario_provisional' DO NOTHING
     RETURNING id`,
    [datos.clickupTaskId, datos.nivel as Nivel, datos.fechaInteraccion],
  );
  return res.rows.length > 0;
}

/**
 * Presupuesto que el cliente marcó en el formulario web (fuente «formulario», emisor cliente). Un solo evento por lead:
 * la fecha es la de creación de la tarjeta, así que cualquier llamada posterior que traiga un importe del cliente lo
 * sustituye (RN-8). Repetirlo no duplica. Una opción que no es una de las 4 no se guarda (devuelve false).
 */
export async function registrarPresupuestoFormulario(
  db: Db,
  datos: { clickupTaskId: string; opcion: string | null; fechaInteraccion: string },
): Promise<boolean> {
  const p = presupuestoDelFormulario(datos.opcion);
  if (p === null) return false;
  const res = await db.query(
    `INSERT INTO lead_presupuesto_evento
       (clickup_task_id, fuente, tipo, valor_min, valor_max, valor_vigente, moneda, emisor, cita_textual,
        interaccion_id, fecha_interaccion, registrado_por)
     VALUES ($1, 'formulario', $2, $3, $4, $5, 'EUR', 'cliente', $6, $7, $8, 'sistema')
     ON CONFLICT ON CONSTRAINT lead_presupuesto_evento_interaccion_uq DO NOTHING
     RETURNING id`,
    [datos.clickupTaskId, p.tipo, p.valorMin, p.valorMax, p.valorVigente, datos.opcion, `formulario:${datos.clickupTaskId}`, datos.fechaInteraccion],
  );
  return res.rows.length > 0;
}

/** El comercial marca o quita a mano el No apto (no exige cita). */
export async function registrarNoAptoManual(
  db: Db,
  datos: { clickupTaskId: string; valor: boolean; usuarioId: string; fecha: string },
): Promise<void> {
  await db.query(
    `INSERT INTO lead_no_apto_evento (clickup_task_id, valor, fecha_interaccion, registrado_por, usuario_id)
     VALUES ($1, $2, $3, 'usuario', $4)`,
    [datos.clickupTaskId, datos.valor, datos.fecha, datos.usuarioId],
  );
}

// ---------------------------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------------------------

export interface EstadoLead {
  eventosPresupuesto: EventoPresupuesto[];
  evaluaciones: EvaluacionCriterio[];
  eventosNoApto: EventoNoApto[];
  /** Última fila del histórico (por orden de inserción), o null si el lead es nuevo. */
  previo: EstadoPrevio | null;
  /**
   * La categoría vigente la puso la matriz (la última decisión fue una evaluación, no un cambio manual
   * del comercial). Un cambio manual se mantiene hasta que se procese la siguiente llamada (P-12).
   */
  categoriaPorMatriz: boolean;
}

export async function cargarEstado(db: Db, clickupTaskId: string): Promise<EstadoLead> {
  // Consultas en serie: es una sola conexión (puede estar dentro de una transacción).
  const presupuestos = await db.query(
    `SELECT id, fuente, tipo, valor_min::float8 AS valor_min, valor_max::float8 AS valor_max, valor_vigente::float8 AS valor_vigente,
            fecha_interaccion, creado_en, registrado_por, usuario_id, interaccion_id, cita_textual, emisor
     FROM lead_presupuesto_evento WHERE clickup_task_id = $1`,
    [clickupTaskId],
  );
  const criterios = await db.query(
    `SELECT criterio_id, nivel, origen, cita, fecha_interaccion, creado_en
     FROM lead_criterio_evaluacion WHERE clickup_task_id = $1`,
    [clickupTaskId],
  );
  const noAptos = await db.query(
    `SELECT valor, cita, registrado_por, fecha_interaccion, creado_en
     FROM lead_no_apto_evento WHERE clickup_task_id = $1`,
    [clickupTaskId],
  );
  const historial = await db.query(
    `SELECT categoria, presupuesto_vigente::float8 AS presupuesto_vigente, ponderado::float8 AS ponderado,
            puntuacion::float8 AS puntuacion, cobertura::float8 AS cobertura, version_config
     FROM lead_calificacion_historial WHERE clickup_task_id = $1 ORDER BY seq DESC LIMIT 1`,
    [clickupTaskId],
  );
  const origen = await db.query(
    `SELECT motivo FROM lead_calificacion_historial
     WHERE clickup_task_id = $1 AND motivo IN ('cambio_categoria_manual', 'evaluacion_ia') ORDER BY seq DESC LIMIT 1`,
    [clickupTaskId],
  );
  const ultima = historial.rows[0];
  return {
    eventosPresupuesto: presupuestos.rows.map((f) => ({
      id: String(f.id),
      fuente: f.fuente as Fuente,
      tipo: f.tipo as EventoPresupuesto['tipo'],
      valorMin: num(f.valor_min),
      valorMax: num(f.valor_max),
      valorVigente: Number(f.valor_vigente),
      fechaInteraccion: iso(f.fecha_interaccion),
      creadoEn: iso(f.creado_en),
      registradoPor: f.registrado_por as EventoPresupuesto['registradoPor'],
      usuarioId: texto(f.usuario_id),
      interaccionId: texto(f.interaccion_id),
      citaTextual: texto(f.cita_textual),
      emisor: f.emisor === 'lyn' ? ('lyn' as const) : ('cliente' as const),
    })),
    evaluaciones: criterios.rows.map((f) => ({
      criterioId: f.criterio_id as CriterioId,
      nivel: f.nivel as NivelONE,
      origen: f.origen as EvaluacionCriterio['origen'],
      cita: texto(f.cita),
      fechaInteraccion: iso(f.fecha_interaccion),
      creadoEn: iso(f.creado_en),
    })),
    eventosNoApto: noAptos.rows.map((f) => ({
      valor: Boolean(f.valor),
      cita: texto(f.cita),
      registradoPor: f.registrado_por as EventoNoApto['registradoPor'],
      fechaInteraccion: iso(f.fecha_interaccion),
      creadoEn: iso(f.creado_en),
    })),
    previo: ultima
      ? {
          categoria: ultima.categoria as Categoria,
          presupuestoVigente: num(ultima.presupuesto_vigente),
          ponderado: num(ultima.ponderado),
          puntuacion: num(ultima.puntuacion),
          cobertura: num(ultima.cobertura),
          versionConfig: Number(ultima.version_config),
        }
      : null,
    categoriaPorMatriz: origen.rows[0]?.motivo === 'evaluacion_ia',
  };
}

// ---------------------------------------------------------------------------------------------
// Recalcular un lead
// ---------------------------------------------------------------------------------------------

export interface ResultadoRecalculo {
  calificacion: Calificacion;
  agregacion: ResultadoAgregacion;
  /** Lo único que hay que escribir en la tarea de ClickUp (ya validado contra los campos permitidos). */
  escrituras: Calificacion['escrituras'] & { desglose?: string };
  filasInsertadas: number;
}

/**
 * Recalcula un lead con TODO lo que hay guardado y agrega al histórico las filas que correspondan.
 * - `evaluacion_ia`: la categoría la fija la matriz de 7 criterios (sustituye a una manual anterior, P-12).
 * - `categoria_manual`: manda la que eligió el comercial (`categoriaElegida`), con la regla de A+ de N-1.1.
 * - `presupuesto` y `recalculo`: si la categoría vigente la puso la matriz, se vuelve a calcular con ella;
 *   si la puso el comercial, se conserva.
 */
export async function recalcularLead(
  db: Db,
  clickupTaskId: string,
  opciones: { disparador: Disparador; categoriaElegida?: Categoria | null; config?: ConfigVigente },
): Promise<ResultadoRecalculo> {
  const config = opciones.config ?? (await cargarConfig(db));
  const estado = await cargarEstado(db, clickupTaskId);
  const presupuesto = presupuestoVigente(estado.eventosPresupuesto);
  const agregacion = calcularCategoria({
    niveles: nivelesVigentes(estado.evaluaciones),
    noApto: noAptoVigente(estado.eventosNoApto),
    presupuestoVigente: presupuesto ? presupuesto.valorVigente : null,
    matriz: config.matriz,
    config: config.agregacion,
  });
  const { disparador } = opciones;
  const usaMatriz =
    disparador === 'evaluacion_ia' || ((disparador === 'presupuesto' || disparador === 'recalculo') && estado.categoriaPorMatriz);

  const calificacion = calificar({
    eventos: estado.eventosPresupuesto,
    categoriaElegida: usaMatriz ? agregacion.categoria : (opciones.categoriaElegida ?? estado.previo?.categoria ?? null),
    previo: estado.previo,
    disparador,
    config: config.categorias,
    versionConfig: config.version,
    umbralAPlus: config.agregacion.umbralAPlus,
    aPlusPermitido: usaMatriz ? agregacion.aPlusPermitido : undefined,
    evaluacion: usaMatriz ? { puntuacion: agregacion.puntuacion, cobertura: agregacion.cobertura } : undefined,
  });

  for (const fila of calificacion.historial) {
    await db.query(
      `INSERT INTO lead_calificacion_historial
         (clickup_task_id, categoria, puntuacion, cobertura, presupuesto_vigente, valor_ponderado, ponderado,
          motivo, evento_presupuesto_id, version_config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        clickupTaskId, fila.categoria, fila.puntuacion ?? null, fila.cobertura ?? null, fila.presupuestoVigente,
        fila.valorPonderado, fila.ponderado, fila.motivo, fila.eventoPresupuestoId, fila.versionConfig,
      ],
    );
  }

  const escrituras = validarEscrituras({
    ...calificacion.escrituras,
    ...(estado.evaluaciones.length > 0 ? { desglose: agregacion.desglose } : {}),
  });
  return { calificacion, agregacion, escrituras, filasInsertadas: calificacion.historial.length };
}

export interface ResultadoRecalculoTodos {
  leads: number;
  filasInsertadas: number;
  /** Leads cuyo histórico cambió, con lo que hay que escribir en su tarea de ClickUp. */
  cambios: Array<{ clickupTaskId: string; escrituras: ResultadoRecalculo['escrituras'] }>;
}

/**
 * Tras cambiar la configuración: recalcula todos los leads conocidos con la versión vigente. Repetirlo no
 * agrega filas. Es todo o nada (abre su propia transacción): si falla a mitad no queda ningún lead a medias,
 * y el reintento devuelve otra vez TODOS los cambios que hay que llevar a ClickUp.
 */
export async function recalcularTodos(db: Db): Promise<ResultadoRecalculoTodos> {
  const config = await cargarConfig(db);
  const recalcular = async (): Promise<ResultadoRecalculoTodos> => {
    const ids = await db.query(
      `SELECT clickup_task_id FROM lead_calificacion_historial
       UNION SELECT clickup_task_id FROM lead_presupuesto_evento
       UNION SELECT clickup_task_id FROM lead_criterio_evaluacion
       UNION SELECT clickup_task_id FROM lead_no_apto_evento
       ORDER BY 1`,
    );
    const resultado: ResultadoRecalculoTodos = { leads: ids.rows.length, filasInsertadas: 0, cambios: [] };
    for (const fila of ids.rows) {
      const clickupTaskId = String(fila.clickup_task_id);
      const r = await recalcularLead(db, clickupTaskId, { disparador: 'recalculo', config });
      resultado.filasInsertadas += r.filasInsertadas;
      if (r.filasInsertadas > 0) resultado.cambios.push({ clickupTaskId, escrituras: r.escrituras });
    }
    return resultado;
  };
  return enTransaccion(db, recalcular);
}

// ---------------------------------------------------------------------------------------------
// Procesar una llamada de punta a punta
// ---------------------------------------------------------------------------------------------

export interface LlamadaAProcesar {
  clickupTaskId: string;
  interaccionId: string;
  fechaInteraccion: string;
  /** Transcripción ya enmascarada, tal como se le dio al modelo. */
  transcripcion: string;
  /** Texto JSON que devolvió el modelo. */
  salidaModelo: string;
}

export type ResultadoProcesar =
  | { estado: 'salida_invalida'; error: string }
  | {
      estado: 'procesada';
      registro: ResultadoRegistro;
      recalculo: ResultadoRecalculo;
      descartes: SalidaVerificada['descartes'];
    };

/**
 * Valida la salida del modelo, comprueba las citas, guarda y recalcula el lead, todo en una transacción.
 * Si la salida no cumple el contrato no se guarda nada y se devuelve `salida_invalida` (el llamador reintenta).
 * Si algo falla al guardar, la transacción se deshace y el error se propaga: la calificación no cambia.
 */
export async function procesarEvaluacionLlamada(db: Db, l: LlamadaAProcesar): Promise<ResultadoProcesar> {
  let verificada: SalidaVerificada;
  try {
    verificada = verificarSalida(validarSalidaModelo(l.salidaModelo, l.interaccionId), l.transcripcion);
  } catch (error) {
    if (error instanceof SalidaInvalida) return { estado: 'salida_invalida', error: error.message };
    throw error;
  }
  return enTransaccion(db, async () => {
    const registro = await registrarEvaluacionLlamada(db, {
      clickupTaskId: l.clickupTaskId,
      interaccionId: l.interaccionId,
      fechaInteraccion: l.fechaInteraccion,
      verificada,
    });
    const recalculo = await recalcularLead(db, l.clickupTaskId, { disparador: 'evaluacion_ia' });
    return { estado: 'procesada' as const, registro, recalculo, descartes: verificada.descartes };
  });
}
