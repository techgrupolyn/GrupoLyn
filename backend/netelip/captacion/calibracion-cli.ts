// Ejecutable de la calibración con el histórico de la decisión de pase (N-1.4). Desde backend/:
//
//   npx tsx netelip/captacion/calibracion-cli.ts --informe C:/ruta/fuera-del-repo/calibracion.csv --confirmo-copia
//   … --desde 2026-09-01 --hasta 2026-11-18   ventana de fechas (por defecto, desde 2020-01-01 hasta mañana: todo el histórico)
//   … --limite 20                             solo las 20 primeras llamadas (prueba corta)
//
// La IA decide sobre todas las llamadas transcritas con lead identificado y se compara con lo que pasó con el lead en «Contacto de
// Reforma» (solo lectura: no escribe nada en ClickUp). Las decisiones quedan como históricas y no cuentan para el acierto del piloto.
// El lote guarda evaluaciones en las tablas de la captación: usa una COPIA de la base (igual que lote-cli.ts) y --confirmo-copia.
// Variables: DATABASE_URL, CLICKUP_API_TOKEN, CAPTACION_CLICKUP_LIST_ID y GOOGLE_GEMINI_API_KEY (o CAPTACION_GEMINI_API_KEY).
// El informe lleva nombres de leads: guárdalo fuera del repo y no lo pegues en chats.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { evaluadorGemini, type Evaluador } from '../calificador/modelo.ts';
import { ejecutarCalibracion, type InformeCalibracion } from './calibracion.ts';
import { ClickUpClient, clickupConfigDesdeEnv } from './clickup.ts';
import { baseParecePruebas, celda } from './lote-cli.ts';
import { ESQUEMA_SALIDA } from './prompt.ts';
import { ensureCaptacion } from './schema.ts';

export interface ArgumentosCalibracion {
  desde: Date;
  hasta: Date;
  limite: number | undefined;
  informe: string;
  confirmoCopia: boolean;
}

const fecha = (valor: string, nombre: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) throw new Error(`${nombre} debe ser una fecha AAAA-MM-DD`);
  const d = new Date(`${valor}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== valor) throw new Error(`${nombre} no es una fecha válida: ${valor}`);
  return d;
};

/** Lee los argumentos. Sin --desde ni --hasta toma todo el histórico (desde 2020-01-01 hasta mañana, en UTC). */
export function leerArgumentosCalibracion(argv: readonly string[], ahora: Date = new Date()): ArgumentosCalibracion {
  const valores = new Map<string, string>();
  let confirmoCopia = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`Argumento inesperado: ${a}`);
    const nombre = a.slice(2);
    if (nombre === 'confirmo-copia') confirmoCopia = true;
    else if (['desde', 'hasta', 'informe', 'limite'].includes(nombre)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`Falta el valor de --${nombre}`);
      valores.set(nombre, v);
      i += 1;
    } else throw new Error(`Argumento desconocido: ${a}`);
  }
  const informe = valores.get('informe');
  if (!informe) throw new Error('Falta --informe con la ruta del archivo CSV (fuera del repo)');
  const manana = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate() + 1));
  const desde = valores.has('desde') ? fecha(valores.get('desde')!, '--desde') : new Date('2020-01-01T00:00:00Z');
  const hasta = valores.has('hasta') ? fecha(valores.get('hasta')!, '--hasta') : manana;
  if (hasta <= desde) throw new Error('--hasta debe ser posterior a --desde');
  const lim = valores.get('limite');
  if (lim !== undefined && (!/^\d+$/.test(lim) || !Number.isSafeInteger(Number(lim)))) throw new Error('--limite debe ser un número entero (0 o más)');
  return { desde, hasta, informe, limite: lim === undefined ? undefined : Number(lim), confirmoCopia };
}

/** CSV para Excel (UTF-8 con BOM, «;»): una fila por llamada analizada, con la decisión de la IA y el desenlace del lead. */
export function informeCsvCalibracion(i: InformeCalibracion): string {
  const cabecera = ['fecha', 'llamada', 'lead', 'lead_id', 'etapa_actual', 'categoria', 'decision_ia', 'motivo', 'excepciones', 'dudas', 'pendiente_de_ernesto', 'desenlace', 'no_continuidad', 'contraste'];
  const filas = i.filas.map((f) => [
    f.fecha, f.llamadaId, f.lead, f.leadId, f.etapa ?? '', f.categoria ?? '', f.decisionIA ?? '', f.motivo ?? '', f.excepciones.join(' | '), f.dudas.join(' | '),
    f.pendienteErnesto ? 'sí' : 'no', f.desenlace, f.noContinuidad ?? '', f.contraste ?? '',
  ]);
  return `\uFEFF${[cabecera, ...filas].map((fila) => fila.map(celda).join(';')).join('\r\n')}\r\n`;
}

/** Resumen para la pantalla: solo totales, sin nombres. */
export function resumenCalibracion(i: InformeCalibracion): string {
  const r = i.resumen;
  const cuentas = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(' · ') || '—';
  return [
    `Llamadas con transcripción: ${r.llamadas} · analizadas (con lead identificado): ${r.analizadas} · sin lead identificado (fuera del informe): ${r.sinLead} · con error: ${r.errores}`,
    `Decisión de la IA: ${r.conDecision} con decisión · ${r.sinDecision} sin ella → ${cuentas(r.porDecision)}`,
    `Frente al desenlace del lead: ${cuentas(r.porContraste)}${r.coincidenciaPorcentaje === null ? '' : ` · coincide el ${r.coincidenciaPorcentaje} % de los que tienen referencia`}`,
  ].join('\n');
}

export async function mainCalibracion(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const a = leerArgumentosCalibracion(argv);
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('Falta DATABASE_URL (usa una copia de la base, nunca la de producción)');
  if (!baseParecePruebas(databaseUrl) && !a.confirmoCopia) {
    throw new Error('DATABASE_URL no parece una base de pruebas (local y con «copia», «local», «prueba», «test» o «qa» en el nombre; un túnel hacia producción también es local). La calibración guarda evaluaciones y decisiones históricas en las tablas de la captación: usa una COPIA de la base y repite con --confirmo-copia.');
  }
  const config = clickupConfigDesdeEnv(env);
  if (!config) throw new Error('Faltan CLICKUP_API_TOKEN y/o CAPTACION_CLICKUP_LIST_ID');
  const modelo = evaluadorGemini(
    { ...env, GOOGLE_GEMINI_API_KEY: env.CAPTACION_GEMINI_API_KEY?.trim() || env.GOOGLE_GEMINI_API_KEY, CALIFICADOR_MODEL: env.CAPTACION_MODEL?.trim() || env.CALIFICADOR_MODEL },
    fetch, { schema: ESQUEMA_SALIDA, maxOutputTokens: 8192 },
  );
  if (!modelo) console.warn('Sin clave de Gemini (GOOGLE_GEMINI_API_KEY o CAPTACION_GEMINI_API_KEY): las llamadas con lead quedarán como fallo del modelo.');
  const evaluar: Evaluador = modelo ?? (async () => { throw new Error('sin clave de Gemini'); });

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await ensureCaptacion(pool);
    const informe = await ejecutarCalibracion({ pool, cliente: new ClickUpClient(config), evaluar, desde: a.desde, hasta: a.hasta, limite: a.limite, registro: (m) => console.log(m) });
    writeFileSync(a.informe, informeCsvCalibracion(informe), 'utf8');
    console.log(resumenCalibracion(informe));
    console.log(`Informe: ${a.informe}`);
    return 0;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mainCalibracion(process.argv.slice(2)).then((codigo) => process.exit(codigo), (error) => {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  });
}
