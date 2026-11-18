// N-1.4 · Reflejar la decisión final del lead en su tarjeta de ClickUp (campo «Decisión de pase»). Cliente de ClickUp de mentira.
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CampoLista, TareaClickUp } from '../netelip/captacion/clickup.ts';
import { CAMPO_DECISION_PASE, reflejoEnClickUp, sincronizarDecisionPase } from '../netelip/captacion/decision-clickup.ts';
import { confirmarCaso, registrarDecisionIA, registrarPropuestaSDR } from '../netelip/captacion/decision-repositorio.ts';
import type { Db } from '../netelip/captacion/repositorio.ts';
import { ensureCaptacion } from '../netelip/captacion/schema.ts';
import { abrirBaseAislada, hayBaseDePruebas, type BaseAislada } from './helpers/captacion-base.ts';

describe('reflejoEnClickUp', () => {
  it('sin el token o sin la lista de ClickUp no hace nada (undefined); con los dos, devuelve la función sin llamar a la red', () => {
    const pool = {} as unknown as Pool;
    expect(reflejoEnClickUp(pool, {})).toBeUndefined();
    expect(reflejoEnClickUp(pool, { CLICKUP_API_TOKEN: 'x' })).toBeUndefined();
    expect(reflejoEnClickUp(pool, { CAPTACION_CLICKUP_LIST_ID: '123' })).toBeUndefined();
    expect(typeof reflejoEnClickUp(pool, { CLICKUP_API_TOKEN: 'x', CAPTACION_CLICKUP_LIST_ID: '123' })).toBe('function');
  });
});

describe.skipIf(!hayBaseDePruebas)('sincronizarDecisionPase', () => {
  let base: BaseAislada;
  let db: Db;
  beforeEach(async () => {
    base = await abrirBaseAislada();
    await ensureCaptacion(base);
    db = base as unknown as Db;
  });
  afterEach(async () => {
    await base.cerrar();
  });

  class ClickUpFalso {
    campos_: CampoLista[] = [{ id: 'f-pase', name: CAMPO_DECISION_PASE, type: 'text', opciones: [] }];
    valor: string | null = null;
    llamadas: string[] = [];
    escrituras: Array<[string, string, string | number]> = [];
    async campos(): Promise<CampoLista[]> { this.llamadas.push('campos'); return this.campos_; }
    async tarea(id: string): Promise<TareaClickUp> {
      this.llamadas.push('tarea');
      return { id, nombre: 'Lead', esPadre: true, estado: 'abierta', cerrada: false, creadaEn: 0, campos: { [CAMPO_DECISION_PASE]: this.valor } };
    }
    async escribirCampo(t: string, c: string, v: string | number): Promise<void> { this.llamadas.push('escribir'); this.escrituras.push([t, c, v]); this.valor = String(v); }
  }

  async function casoRevisado(nombre = 'Ernesto'): Promise<void> {
    await base.query(
      `INSERT INTO lead_criterio_evaluacion (clickup_task_id, criterio_id, nivel, origen, interaccion_id, fecha_interaccion) VALUES ('T1', 'presupuesto', 'NE', 'llamada', 'netelip:1', now())`,
    );
    await registrarDecisionIA(db, {
      leadId: 'T1', llamadaId: 'netelip:1', versionGuion: 1, versionManual: 1, versionPrompt: 'v', origen: 'nuevo',
      decision: { decision: 'seguimiento', motivos: [{ codigo: 'falta_plano', texto: null, cita: 'el plano' }], excepciones: [], dudas: [], pendienteErnesto: null, proximosPasos: [] },
    });
    await registrarPropuestaSDR(db, { llamadaId: 'netelip:1', usuarioId: '5', usuarioNombre: 'Sara', entrada: { decision: 'seguimiento', motivoCodigo: 'falta_plano', motivoTexto: null, datoCita: 'x' } });
    await confirmarCaso(db, { llamadaId: 'netelip:1', revisor: { usuarioId: '7', usuarioNombre: nombre } });
  }

  it('sin ninguna decisión revisada no toca ClickUp (ni siquiera lo consulta)', async () => {
    const ck = new ClickUpFalso();
    expect(await sincronizarDecisionPase(db, ck, 'T1')).toEqual({ estado: 'sin_decision' });
    expect(ck.llamadas).toEqual([]);
  });

  it('escribe la decisión final y quién la tomó en el campo «Decisión de pase», y solo en ese', async () => {
    expect(CAMPO_DECISION_PASE).toBe('Decisión de pase');
    await casoRevisado();
    const ck = new ClickUpFalso();
    expect(await sincronizarDecisionPase(db, ck, 'T1')).toEqual({ estado: 'escrito', texto: 'Seguimiento · Ernesto' });
    expect(ck.escrituras).toEqual([['T1', 'f-pase', 'Seguimiento · Ernesto']]);
  });

  it('repetirlo no vuelve a escribir cuando la tarjeta ya lo dice (aunque tenga espacios de más); si otra persona lo cambió, lo restituye', async () => {
    await casoRevisado();
    const ck = new ClickUpFalso();
    await sincronizarDecisionPase(db, ck, 'T1');
    ck.valor = '  Seguimiento · Ernesto ';
    expect(await sincronizarDecisionPase(db, ck, 'T1')).toEqual({ estado: 'al_dia', texto: 'Seguimiento · Ernesto' });
    expect(ck.escrituras).toHaveLength(1);
    ck.valor = 'Descartar · alguien';
    expect(await sincronizarDecisionPase(db, ck, 'T1')).toEqual({ estado: 'escrito', texto: 'Seguimiento · Ernesto' });
    expect(ck.escrituras).toHaveLength(2);
  });

  it('si la lista aún no tiene el campo no escribe nada y no es un error (lo crea un administrador)', async () => {
    await casoRevisado();
    const ck = new ClickUpFalso();
    ck.campos_ = [];
    expect(await sincronizarDecisionPase(db, ck, 'T1')).toEqual({ estado: 'sin_campo' });
    expect(ck.llamadas).toEqual(['campos']);
  });

  it('es informativo: no escribe ningún otro campo ni mueve la fase de la tarjeta', async () => {
    await casoRevisado('Dirección');
    const ck = new ClickUpFalso();
    ck.campos_.push({ id: 'f-etapa', name: 'ETAPA_CRM', type: 'drop_down', opciones: [] });
    await sincronizarDecisionPase(db, ck, 'T1');
    expect(ck.escrituras.map(([, campo]) => campo)).toEqual(['f-pase']);
    expect(ck.escrituras[0]![2]).toBe('Seguimiento · Dirección');
  });
});
