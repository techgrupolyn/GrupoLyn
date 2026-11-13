// Panel de marketing (épico 869fny1et, base común M-1): tablas aditivas e idempotentes, aplicadas en
// cada arranque. Solo datos agregados o seudónimos: ningún nombre, teléfono ni email de un lead.
// Reversión: backend/marketing/schema-down.sql.
import type { Pool } from 'pg';

export const MARKETING_TABLES = [
  'mk_carga', 'mk_zona_regla', 'mk_familia_creativa', 'mk_curva_maduracion', 'mk_valor_letra', 'mk_lead', 'mk_gasto_diario',
] as const;

/** Letras del calificador de leads, de mejor a peor. «No apto» vale 0 en el ponderado (RN-3 de 869fny187). */
export const LETRAS = ['A++', 'A+', 'A', 'B', 'C', 'D', 'No apto'] as const;
export type Letra = typeof LETRAS[number];
export const VALOR_LETRA_INICIAL: Record<Letra, number> = { 'A++': 1, 'A+': 1, A: 1, B: 0.75, C: 0.45, D: 0.15, 'No apto': 0 };

/** Hitos del embudo con curva de maduración, en orden. */
export const HITOS = ['calidad', 'visita', 'diseno', 'seguimiento', 'ganado'] as const;
export type Hito = typeof HITOS[number];
export const EDADES_CURVA = [7, 14, 30, 60, 90, 120, 180] as const;
// Valores iniciales del mockup de Producto (10/11). Se recalculan con el histórico de 12 meses cuando lo haya.
export const CURVAS_INICIALES: Record<Hito, number[]> = {
  calidad: [0.45, 0.65, 0.85, 0.95, 1, 1, 1],
  visita: [0.30, 0.55, 0.80, 0.95, 1, 1, 1],
  diseno: [0.05, 0.20, 0.45, 0.75, 0.90, 0.97, 1],
  seguimiento: [0.02, 0.10, 0.30, 0.60, 0.80, 0.92, 1],
  ganado: [0, 0.02, 0.10, 0.35, 0.60, 0.80, 0.95],
};

// Zona a partir del nombre de la campaña: gana el patrón que aparece antes en el nombre (P-08: «Sureste» por confirmar).
// «Excluida» saca la campaña del panel: las ofertas de empleo no son captación. Nombres reales de Meta (11/11/2026).
const ZONAS_INICIALES: Array<[string, string]> = [
  ['alicante', 'Alicante'], ['murcia', 'Murcia'], ['sureste', 'Sureste'],
  ['creacion de marca', 'Marca (Alicante y Murcia)'], ['ofertas de trabajo', 'Excluida'],
];
// Familias de creativos de Alex (04/11): patrón sobre el nombre del anuncio → familia. Se mantiene a mano.
const FAMILIAS_INICIALES: Array<[string, string, number]> = [
  ['idan', 'Casa Idan', 10],
  ['hook', 'Reel Hooks · Abril', 20],
  ['control de la reforma', 'A3 · Control de la reforma', 30],
  ['hogar como siempre', 'Tu hogar como siempre lo soñaste', 40],
  ['at4', 'Serie T4 / AT4', 50],
  ['t4', 'Serie T4 / AT4', 51],
  ['cocina', 'Reformas de cocinas', 60],
  ['page post', 'Reel 2 / Page post · Febrero NN', 70],
  ['reel', 'Reels', 90],
];

export async function ensureMarketing(pool: Pool): Promise<void> {
  await pool.query(`
    -- Gasto diario por anuncio, tal como lo entrega Windsor. Google no tiene conjunto ni anuncio: van vacíos.
    CREATE TABLE IF NOT EXISTS mk_gasto_diario (
      fecha DATE NOT NULL,
      canal TEXT NOT NULL CHECK (canal IN ('meta','google')),
      campana_id TEXT NOT NULL,
      campana TEXT NOT NULL,
      conjunto_id TEXT NOT NULL DEFAULT '',
      conjunto TEXT NOT NULL DEFAULT '',
      anuncio_id TEXT NOT NULL DEFAULT '',
      anuncio TEXT NOT NULL DEFAULT '',
      gasto NUMERIC(12,2) NOT NULL DEFAULT 0,
      clics INTEGER NOT NULL DEFAULT 0,
      impresiones INTEGER NOT NULL DEFAULT 0,
      leads_plataforma INTEGER NOT NULL DEFAULT 0,   -- leads que cuenta Meta (actions_lead): formularios instantáneos
      cargado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (fecha, canal, campana_id, conjunto_id, anuncio_id)
    );

    -- Un lead de «Contacto de Reforma» (solo tareas padre) sin datos personales: el identificador es un hash.
    CREATE TABLE IF NOT EXISTS mk_lead (
      lead_hash TEXT PRIMARY KEY,
      fecha_alta TIMESTAMPTZ NOT NULL,
      canal TEXT NOT NULL,                 -- meta | google | tally | otro
      canal_origen TEXT,                   -- valor del campo canal de ClickUp (1, 2, 3, 3.1…)
      utm_campaign TEXT,
      utm_term TEXT,
      utm_content TEXT,
      anuncio_id TEXT,
      letra_entrada TEXT,                  -- primera letra conocida; la definitiva llegará con el histórico de N-1.2
      letra_confirmada TEXT,               -- letra vigente
      importe_estimado NUMERIC(12,2),
      etapa TEXT,                          -- ETAPA_CRM (e1…e18)
      llego_visita BOOLEAN NOT NULL DEFAULT FALSE,
      llego_diseno BOOLEAN NOT NULL DEFAULT FALSE,
      llego_seguimiento BOOLEAN NOT NULL DEFAULT FALSE,
      llego_ganado BOOLEAN NOT NULL DEFAULT FALSE,
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS mk_lead_alta ON mk_lead(fecha_alta);
    ALTER TABLE mk_gasto_diario ADD COLUMN IF NOT EXISTS leads_plataforma INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS mk_valor_letra (
      letra TEXT PRIMARY KEY,
      valor NUMERIC(4,3) NOT NULL CHECK (valor BETWEEN 0 AND 1),
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Fracción acumulada de las llegadas a un hito que ya han ocurrido a una antigüedad dada.
    CREATE TABLE IF NOT EXISTS mk_curva_maduracion (
      hito TEXT NOT NULL,
      dias INTEGER NOT NULL CHECK (dias > 0),
      fraccion NUMERIC(4,3) NOT NULL CHECK (fraccion BETWEEN 0 AND 1),
      version INTEGER NOT NULL DEFAULT 1,
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (hito, dias)
    );

    CREATE TABLE IF NOT EXISTS mk_familia_creativa (
      patron TEXT PRIMARY KEY,             -- texto que contiene el nombre del anuncio (sin distinguir mayúsculas)
      familia TEXT NOT NULL,
      prioridad INTEGER NOT NULL DEFAULT 100
    );

    CREATE TABLE IF NOT EXISTS mk_zona_regla (
      patron TEXT PRIMARY KEY,             -- texto que contiene el nombre de la campaña
      zona TEXT NOT NULL,
      prioridad INTEGER NOT NULL DEFAULT 100
    );

    -- Registro de cargas: la última correcta se muestra en el panel y evita repetir la del día.
    CREATE TABLE IF NOT EXISTS mk_carga (
      id BIGSERIAL PRIMARY KEY,
      fuente TEXT NOT NULL CHECK (fuente IN ('windsor','clickup')),
      inicio TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      fin TIMESTAMPTZ,
      estado TEXT NOT NULL DEFAULT 'en_curso' CHECK (estado IN ('en_curso','ok','error')),
      filas INTEGER,
      detalle TEXT
    );
    CREATE INDEX IF NOT EXISTS mk_carga_fuente ON mk_carga(fuente, inicio DESC);
  `);

  // Valores iniciales: solo si faltan, para no pisar lo que Dirección haya editado.
  await pool.query(
    `INSERT INTO mk_valor_letra (letra, valor) SELECT * FROM UNNEST($1::text[], $2::numeric[]) ON CONFLICT (letra) DO NOTHING`,
    [LETRAS as unknown as string[], LETRAS.map((l) => VALOR_LETRA_INICIAL[l])]);
  const curvas = HITOS.flatMap((h) => EDADES_CURVA.map((d, i) => [h, d, CURVAS_INICIALES[h][i]] as const));
  await pool.query(
    `INSERT INTO mk_curva_maduracion (hito, dias, fraccion) SELECT * FROM UNNEST($1::text[], $2::int[], $3::numeric[]) ON CONFLICT (hito, dias) DO NOTHING`,
    [curvas.map((c) => c[0]), curvas.map((c) => c[1]), curvas.map((c) => c[2])]);
  await pool.query(
    `INSERT INTO mk_zona_regla (patron, zona) SELECT * FROM UNNEST($1::text[], $2::text[]) ON CONFLICT (patron) DO NOTHING`,
    [ZONAS_INICIALES.map((z) => z[0]), ZONAS_INICIALES.map((z) => z[1])]);
  await pool.query(
    `INSERT INTO mk_familia_creativa (patron, familia, prioridad) SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[]) ON CONFLICT (patron) DO NOTHING`,
    [FAMILIAS_INICIALES.map((f) => f[0]), FAMILIAS_INICIALES.map((f) => f[1]), FAMILIAS_INICIALES.map((f) => f[2])]);
}
