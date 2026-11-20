import type { Express, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { puedeValidarDecisiones } from './decision-rutas.ts';

// N-1.0 · Llamadas de Netelip y su lead de «Contacto de Reforma»: la lista de las que tienen varias coincidencias (no se asignan solas) y
// la asignación a mano. Leer exige acceso al Historial de llamadas; asignar, el mismo permiso que validar decisiones de pase. Nada de esto
// escribe en ClickUp.

type Deps = {
  pool: Pool;
  /** Sesión del Dashboard con acceso a Historial de llamadas. */
  access: RequestHandler;
  role: (res: Response) => string;
  actor?: (res: Response) => { id: string; nombre: string };
  fail: (res: Response, error: unknown) => void;
  env: NodeJS.ProcessEnv;
};

interface Candidato { id: string; nombre: string }

/** URL de la tarjeta en ClickUp: el identificador solo lleva letras y cifras. */
export const urlTarjeta = (id: string): string | null => (/^[A-Za-z0-9]+$/.test(id) ? `https://app.clickup.com/t/${id}` : null);

export function registerVinculoLlamadas(app: Express, deps: Deps): void {
  const { pool, access, fail, env } = deps;

  app.get('/api/captacion/llamadas/sin-asignar', access, async (_req, res) => {
    try {
      const [lista, cuentas] = await Promise.all([
        pool.query<{ call_id: string; occurred_at: Date; phone: string | null; candidatos: Candidato[] }>(
          `SELECT v.call_id::text AS call_id, c.occurred_at, c.phone_e164 AS phone, v.candidatos
             FROM captacion_llamada_lead v JOIN netelip_calls c ON c.id = v.call_id
            WHERE v.estado = 'varias_coincidencias'
            ORDER BY c.occurred_at DESC, c.id DESC LIMIT 500`,
        ),
        pool.query<{ estado: string; n: string }>(`SELECT estado, COUNT(*) AS n FROM captacion_llamada_lead GROUP BY estado`),
      ]);
      const porEstado = Object.fromEntries(cuentas.rows.map((r) => [r.estado, Number(r.n)]));
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        resumen: {
          vinculadas: porEstado.vinculada ?? 0, varias_coincidencias: porEstado.varias_coincidencias ?? 0,
          sin_coincidencia: porEstado.sin_coincidencia ?? 0, sin_datos: porEstado.sin_datos ?? 0,
        },
        items: lista.rows.map((r) => ({
          llamada_id: Number(r.call_id), occurred_at: r.occurred_at, phone: r.phone,
          candidatos: r.candidatos.map((c) => ({ id: c.id, nombre: c.nombre, url: urlTarjeta(c.id) })),
        })),
      });
    } catch (error) { fail(res, error); }
  });

  app.post('/api/captacion/llamadas/:id/asignar', access, async (req, res) => {
    if (!puedeValidarDecisiones(deps.role(res), env)) return res.status(403).json({ error: 'No tienes permiso para asignar llamadas a un lead.' });
    const id = Number(req.params.id);
    const tarea = typeof req.body?.clickup_task_id === 'string' ? req.body.clickup_task_id.trim() : '';
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Identificador de llamada no válido.' });
    if (!tarea) return res.status(400).json({ error: 'Falta la tarjeta del lead a la que asignar la llamada.' });
    const quien = deps.actor?.(res)?.nombre || 'desconocido';
    const conexion = await pool.connect();
    try {
      await conexion.query('BEGIN');
      const { rows } = await conexion.query<{ estado: string; candidatos: Candidato[] }>(
        `SELECT estado, candidatos FROM captacion_llamada_lead WHERE call_id = $1 FOR UPDATE`, [id],
      );
      const fila = rows[0];
      if (!fila) { await conexion.query('ROLLBACK'); return res.status(404).json({ error: 'La llamada no tiene cruce con leads.' }); }
      if (fila.estado !== 'varias_coincidencias') { await conexion.query('ROLLBACK'); return res.status(409).json({ error: 'Esta llamada no está pendiente de asignar a mano.' }); }
      const elegido = fila.candidatos.find((c) => c.id === tarea);
      if (!elegido) { await conexion.query('ROLLBACK'); return res.status(400).json({ error: 'La tarjeta elegida no es una de las coincidencias de esta llamada.' }); }
      await conexion.query(
        `UPDATE captacion_llamada_lead
            SET estado = 'vinculada', clickup_task_id = $2, lead_nombre = $3, via = 'manual', origen = 'manual', candidatos = '[]'::jsonb,
                asignada_por = $4, actualizado_en = now()
          WHERE call_id = $1`,
        [id, elegido.id, elegido.nombre, quien.slice(0, 200)],
      );
      // Si la llamada ya se había rendido como «sin lead» en la cola de la calificación, vuelve a intentarse con la asignación hecha.
      await conexion.query(
        `UPDATE captacion_cola SET estado = 'pendiente', sin_lead_veces = 0, proximo_intento = now(), motivo = NULL, actualizado_en = now()
          WHERE llamada_id = $1::text AND estado = 'sin_lead'`,
        [String(id)],
      );
      await conexion.query('COMMIT');
      res.json({ llamada_id: id, clickup_task_id: elegido.id, lead_nombre: elegido.nombre, via: 'manual' });
    } catch (error) {
      await conexion.query('ROLLBACK').catch(() => undefined);
      fail(res, error);
    } finally {
      conexion.release();
    }
  });
}
