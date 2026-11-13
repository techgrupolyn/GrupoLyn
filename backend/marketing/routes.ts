// API del panel de marketing para el Dashboard: /api/marketing/...
import type { Express, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { ejecutarCarga, type Fuente } from './carga.ts';
import { datosPanel } from './panel.ts';
import { EDADES_CURVA, HITOS, LETRAS } from './schema.ts';

type Deps = {
  pool: Pool;
  /** Sesión de administración del Dashboard (requireCeoAuth). */
  admin: RequestHandler;
  role: (res: Response) => string;
  fail: (res: Response, error: unknown) => void;
  env?: NodeJS.ProcessEnv;
};

const normalizeRole = (role: unknown) =>
  String(role || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[\s/-]+/g, '_');
const enLista = (lista: string, role: unknown) => lista.split(',').map(normalizeRole).filter(Boolean).includes(normalizeRole(role));

// El panel lo ven Dirección y quien Alex indique; la nota comercial (desempeño de empleados), solo Dirección y Ernesto.
const DEFAULT_ACCESS_ROLES = 'superadmin,admin,ceo,employee:director,employee:director_general';
const DEFAULT_NOTA_ROLES = 'superadmin,admin,ceo,employee:director,employee:director_general';
const DEFAULT_EDIT_ROLES = 'superadmin,admin,ceo';

export const canAccessMarketing = (role: unknown, env: NodeJS.ProcessEnv = process.env) => enLista(env.MARKETING_ACCESS_ROLES || DEFAULT_ACCESS_ROLES, role);
export const canSeeNota = (role: unknown, env: NodeJS.ProcessEnv = process.env) => enLista(env.MARKETING_NOTA_ROLES || DEFAULT_NOTA_ROLES, role);
export const canEditMarketing = (role: unknown, env: NodeJS.ProcessEnv = process.env) => enLista(env.MARKETING_EDIT_ROLES || DEFAULT_EDIT_ROLES, role);

const fraccion = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1 ? Math.round(n * 1000) / 1000 : null; };

type ReglaIn = { patron?: unknown; valor?: unknown; prioridad?: unknown };
function reglas(lista: unknown, max = 500): Array<{ patron: string; valor: string; prioridad: number }> | null {
  if (!Array.isArray(lista) || lista.length > max) return null;
  const out = [];
  for (const r of lista as ReglaIn[]) {
    const patron = String(r?.patron ?? '').trim().toLowerCase(), valor = String(r?.valor ?? '').trim();
    const prioridad = Number(r?.prioridad ?? 100);
    if (!patron || patron.length > 120 || !valor || valor.length > 120 || !Number.isInteger(prioridad)) return null;
    out.push({ patron, valor, prioridad });
  }
  return new Set(out.map((r) => r.patron)).size === out.length ? out : null;
}

export function registerMarketing(app: Express, deps: Deps): void {
  const { pool, fail } = deps;
  const env = deps.env ?? process.env;
  const access: RequestHandler = (req, res, next) => deps.admin(req, res, () => {
    if (!canAccessMarketing(deps.role(res), env)) return res.status(403).json({ error: 'No tienes acceso al panel de marketing.' });
    next();
  });
  const edit: RequestHandler = (_req, res, next) => {
    if (!canEditMarketing(deps.role(res), env)) return res.status(403).json({ error: 'No tienes permiso para editar las ponderaciones del panel.' });
    next();
  };

  app.get('/api/marketing/panel', access, async (_req, res) => {
    try {
      const data = await datosPanel(pool, { conNota: canSeeNota(deps.role(res), env) });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ...data, permisos: { editar: canEditMarketing(deps.role(res), env), nota: canSeeNota(deps.role(res), env) } });
    } catch (error) { fail(res, error); }
  });

  // Tabla central de ponderaciones: valor por letra y curvas de maduración. Se aplica al recargar, sin desplegar.
  app.put('/api/marketing/ponderaciones', access, edit, async (req, res) => {
    const valores = req.body?.valoresLetra as Record<string, unknown> | undefined;
    const curvas = req.body?.curvas as Record<string, unknown[]> | undefined;
    const filasValor: Array<[string, number]> = [];
    for (const [letra, v] of Object.entries(valores || {})) {
      const f = fraccion(v);
      if (!(LETRAS as readonly string[]).includes(letra) || f == null) return res.status(400).json({ error: `Valor no válido para la letra ${letra}.` });
      filasValor.push([letra, f]);
    }
    const filasCurva: Array<[string, number, number]> = [];
    for (const [hito, arr] of Object.entries(curvas || {})) {
      if (!(HITOS as readonly string[]).includes(hito) || !Array.isArray(arr) || arr.length !== EDADES_CURVA.length) return res.status(400).json({ error: `Curva no válida: ${hito}.` });
      for (let i = 0; i < arr.length; i++) {
        const f = fraccion(arr[i]);
        if (f == null || (i > 0 && f < filasCurva[filasCurva.length - 1][2])) return res.status(400).json({ error: `La curva ${hito} debe ir de 0 a 1 y no puede bajar con la antigüedad.` });
        filasCurva.push([hito, EDADES_CURVA[i], f]);
      }
    }
    try {
      if (filasValor.length) await pool.query(
        `INSERT INTO mk_valor_letra (letra, valor) SELECT * FROM UNNEST($1::text[], $2::numeric[])
         ON CONFLICT (letra) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
        [filasValor.map((x) => x[0]), filasValor.map((x) => x[1])]);
      if (filasCurva.length) await pool.query(
        `INSERT INTO mk_curva_maduracion (hito, dias, fraccion) SELECT * FROM UNNEST($1::text[], $2::int[], $3::numeric[])
         ON CONFLICT (hito, dias) DO UPDATE SET fraccion = EXCLUDED.fraccion, version = mk_curva_maduracion.version + 1, actualizado_en = NOW()`,
        [filasCurva.map((x) => x[0]), filasCurva.map((x) => x[1]), filasCurva.map((x) => x[2])]);
      res.json({ ok: true });
    } catch (error) { fail(res, error); }
  });

  // Reglas de zona (nombre de campaña) y de familia de creativo (nombre del anuncio).
  app.get('/api/marketing/reglas', access, async (_req, res) => {
    try {
      const [z, f] = await Promise.all([
        pool.query('SELECT patron, zona AS valor, prioridad FROM mk_zona_regla ORDER BY prioridad, patron'),
        pool.query('SELECT patron, familia AS valor, prioridad FROM mk_familia_creativa ORDER BY prioridad, patron'),
      ]);
      res.json({ zonas: z.rows, familias: f.rows });
    } catch (error) { fail(res, error); }
  });

  app.put('/api/marketing/reglas', access, edit, async (req, res) => {
    const zonas = req.body?.zonas === undefined ? undefined : reglas(req.body.zonas);
    const familias = req.body?.familias === undefined ? undefined : reglas(req.body.familias);
    if (zonas === null || familias === null) return res.status(400).json({ error: 'Reglas no válidas: patrón y valor obligatorios, sin patrones repetidos.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [tabla, col, lista] of [['mk_zona_regla', 'zona', zonas], ['mk_familia_creativa', 'familia', familias]] as const) {
        if (!lista) continue;
        await client.query(`DELETE FROM ${tabla}`);
        if (lista.length) await client.query(
          `INSERT INTO ${tabla} (patron, ${col}, prioridad) SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[])`,
          [lista.map((r) => r.patron), lista.map((r) => r.valor), lista.map((r) => r.prioridad)]);
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      fail(res, error);
    } finally { client.release(); }
  });

  // Carga manual (además de la diaria). Responde al terminar: Windsor y ClickUp tardan segundos.
  app.post('/api/marketing/cargar', access, edit, async (req, res) => {
    const pedidas = Array.isArray(req.body?.fuentes) ? req.body.fuentes : ['windsor', 'clickup'];
    const fuentes = pedidas.filter((f: unknown): f is Fuente => f === 'windsor' || f === 'clickup');
    try {
      const resultados = await ejecutarCarga(pool, env, fuentes);
      if (!resultados.length) return res.status(409).json({ error: 'No hay ninguna fuente configurada (WINDSOR_API_KEY, CLICKUP_API_TOKEN).' });
      res.json({ resultados });
    } catch (error) { fail(res, error); }
  });
}
