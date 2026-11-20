// Carga inicial de la captación ABCD (N-1.1, acción 8): da de alta en el sistema a TODOS los leads vivos de «Contacto de
// Reforma» (etapas e1 a e13, tarea padre y abierta) y deja en cada tarjeta lo que escribe el sistema, para que la vista «Por
// potencial» ya tenga con qué ordenar. Los leads sin presupuesto también entran (muestran «Pendiente: preguntar en la 1ª
// llamada») y salen en el listado aparte. Por defecto es un SIMULACRO: guarda las altas en las tablas de la captación (usa
// una copia de la base la primera vez) pero no escribe nada en ClickUp. Escribir exige un tope explícito.
//
// Es idempotente y se repara sola: un lead ya dado de alta no se vuelve a dar de alta, y en cada pasada se compara lo que
// calcula el sistema con lo que hay en la tarjeta y solo se escribe lo que difiere (así, una escritura que se quedó sin cupo o
// falló se completa al repetir, y una tarjeta que ya está al día no gasta llamadas ni cupo).
import type { Pool } from 'pg';
import {
  ClickUpConfigError, ClickUpError, ClickUpEscrituraParcial, escribirPlan, NOMBRES_CAMPOS, planEscritura,
  type CambioCampo, type CampoLista, type ClickUpClient, type TareaClickUp,
} from './clickup.ts';
import { esVivo } from './lote.ts';
import {
  bloquearLead, enTransaccion, recalcularLead, registrarNoAptoManual, registrarPresupuestoFormulario, registrarPresupuestoManual,
  type Db, type ResultadoRecalculo,
} from './repositorio.ts';
import { MOTIVO_NO_CONTINUIDAD_PRESUPUESTO, type Categoria } from './tipos.ts';
import { camposDesactualizados, leerCampos } from './webhook.ts';

export interface OpcionesCarga {
  pool: Pool;
  cliente: Pick<ClickUpClient, 'campos' | 'tareas' | 'escribirCampo'>;
  /** Máximo de tarjetas en las que escribir. 0 (por defecto) = simulacro: no se escribe nada en ClickUp. */
  escribirMaximo?: number;
  /** Fecha del presupuesto que ya tenía la tarjeta en ClickUp (RN-8: manda sobre el del formulario, que es de cuando se creó). */
  fechaCarga?: Date;
  registro?: (mensaje: string) => void;
}

export type EscrituraCarga = 'escrito' | 'simulado' | 'sin_cupo' | 'al_dia' | 'error';

export interface FilaCarga {
  clickupTaskId: string;
  nombre: string;
  etapa: string | null;
  accion: 'alta' | 'ya_cargada';
  categoria: Categoria;
  presupuesto: number | null;
  fuente: string;
  ponderado: number | null;
  sinPresupuesto: boolean;
  escritura: EscrituraCarga;
  campos: number;
  detalle: string | null;
}

export interface InformeCarga {
  filas: FilaCarga[];
  resumen: {
    leadsEnLista: number;
    leadsVivos: number;
    altas: number;
    yaCargadas: number;
    sinPresupuesto: number;
    porCategoria: Record<string, number>;
    escritos: number;
    simulados: number;
    sinCupo: number;
    alDia: number;
    errores: number;
  };
}

const conDb = async <T>(pool: Pool, fn: (db: Db) => Promise<T>): Promise<T> => {
  const conexion = await pool.connect();
  try {
    return await fn(conexion);
  } finally {
    conexion.release();
  }
};

/** Un 4xx de ClickUp quiere decir que la petición se rechazó y no se aplicó nada; cualquier otro fallo es ambiguo. */
const noSeAplico = (e: unknown): boolean => e instanceof ClickUpError && e.estado !== null && e.estado >= 400 && e.estado < 500;

/** Alta (o recálculo) de UN lead en una sola transacción: o queda todo o no queda nada. */
async function cargarLead(db: Db, t: TareaClickUp, fechaCarga: string): Promise<{ nueva: boolean; r: ResultadoRecalculo }> {
  return enTransaccion(db, async () => {
    await bloquearLead(db, t.id);
    const previa = await db.query('SELECT 1 FROM lead_calificacion_historial WHERE clickup_task_id = $1 LIMIT 1', [t.id]);
    if (previa.rows.length > 0) return { nueva: false, r: await recalcularLead(db, t.id, { disparador: 'recalculo' }) };

    const ck = leerCampos(t);
    const opcionFormulario = t.campos[NOMBRES_CAMPOS.presupuesto_formulario];
    if (typeof opcionFormulario === 'string') {
      await registrarPresupuestoFormulario(db, { clickupTaskId: t.id, opcion: opcionFormulario, fechaInteraccion: new Date(t.creadaEn || 0).toISOString() });
    }
    // Un importe que ya tenía la tarjeta se registra como presupuesto «manual» con la fecha de la carga.
    if (ck.presupuesto !== null) await registrarPresupuestoManual(db, { clickupTaskId: t.id, valor: ck.presupuesto, usuarioId: null, fecha: fechaCarga });
    let elegida: Categoria | null = ck.categoria;
    if (ck.noContinuidad === MOTIVO_NO_CONTINUIDAD_PRESUPUESTO) {
      await registrarNoAptoManual(db, { clickupTaskId: t.id, valor: true, usuarioId: 'carga-inicial', fecha: fechaCarga });
      elegida = 'no_apto';
    }
    return { nueva: true, r: await recalcularLead(db, t.id, { disparador: 'alta', categoriaElegida: elegida }) };
  });
}

export async function ejecutarCargaInicial(o: OpcionesCarga): Promise<InformeCarga> {
  const registro = o.registro ?? (() => undefined);
  const cupo = o.escribirMaximo ?? 0;
  // Un tope que no sea un entero normal (negativo, decimal, infinito, NaN) nunca debe poder dejar escribir de más.
  if (!Number.isSafeInteger(cupo) || cupo < 0) throw new Error('escribirMaximo debe ser un entero de 0 o más');
  const fechaCarga = (o.fechaCarga ?? new Date()).toISOString();

  const campos: CampoLista[] = await o.cliente.campos();
  const tareas: TareaClickUp[] = [];
  for await (const t of o.cliente.tareas()) if (t.esPadre) tareas.push(t);
  const vivos = tareas.filter(esVivo).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  registro(`ClickUp: ${tareas.length} leads, ${vivos.length} vivos`);

  const filas: FilaCarga[] = [];
  let escritos = 0;
  for (const [i, t] of vivos.entries()) {
    const { nueva, r } = await conDb(o.pool, (db) => cargarLead(db, t, fechaCarga));
    const fila: FilaCarga = {
      clickupTaskId: t.id,
      nombre: t.nombre,
      etapa: (t.campos[NOMBRES_CAMPOS.etapa] as string | null) ?? null,
      accion: nueva ? 'alta' : 'ya_cargada',
      categoria: r.escrituras.categoria,
      presupuesto: r.escrituras.presupuesto,
      fuente: r.escrituras.fuente_presupuesto,
      ponderado: r.escrituras.ponderado,
      sinPresupuesto: r.escrituras.presupuesto === null,
      escritura: 'al_dia',
      campos: 0,
      detalle: null,
    };
    filas.push(fila);
    if (i > 0 && i % 25 === 0) registro(`  ${i}/${vivos.length} leads`);

    // Lo que difiere de la tarjeta. Si la lista no tiene un campo o una opción, falla AQUÍ, antes de escribir nada y sin gastar cupo.
    let aEscribir: CambioCampo[];
    let omitidos: string[];
    try {
      const plan = planEscritura(r.escrituras, campos);
      const pendientes = camposDesactualizados(r.escrituras, t);
      aEscribir = plan.cambios.filter((c) => pendientes.has(c.clave));
      omitidos = plan.omitidos;
    } catch (e) {
      fila.escritura = 'error';
      fila.detalle = e instanceof ClickUpConfigError ? e.message : (e as Error).message.slice(0, 200);
      continue;
    }

    if (aEscribir.length === 0) {
      fila.escritura = 'al_dia';
    } else if (cupo === 0) {
      fila.escritura = 'simulado';
      fila.campos = aEscribir.length;
    } else if (escritos >= cupo) {
      fila.escritura = 'sin_cupo';
      fila.campos = aEscribir.length;
    } else {
      try {
        fila.campos = await escribirPlan(o.cliente, t.id, { cambios: aEscribir, omitidos });
        fila.escritura = 'escrito';
        escritos += 1;
      } catch (e) {
        // Una escritura a medias ya tocó la tarjeta y un corte de red o un 5xx puede haberla aplicado aunque no llegara la
        // respuesta: las dos gastan cupo, para no pasarse del tope. Solo un 4xx de ClickUp garantiza que no se aplicó nada.
        const parcial = e instanceof ClickUpEscrituraParcial;
        if (parcial || !noSeAplico(e)) escritos += 1;
        fila.escritura = 'error';
        fila.campos = parcial ? e.camposEscritos : 0;
        fila.detalle = (e as Error).message.slice(0, 200);
      }
    }
  }

  const contar = (escritura: EscrituraCarga) => filas.filter((f) => f.escritura === escritura).length;
  const porCategoria: Record<string, number> = {};
  for (const f of filas) porCategoria[f.categoria] = (porCategoria[f.categoria] ?? 0) + 1;
  return {
    filas,
    resumen: {
      leadsEnLista: tareas.length,
      leadsVivos: vivos.length,
      altas: filas.filter((f) => f.accion === 'alta').length,
      yaCargadas: filas.filter((f) => f.accion === 'ya_cargada').length,
      sinPresupuesto: filas.filter((f) => f.sinPresupuesto).length,
      porCategoria,
      escritos: contar('escrito'),
      simulados: contar('simulado'),
      sinCupo: contar('sin_cupo'),
      alDia: contar('al_dia'),
      errores: contar('error'),
    },
  };
}
