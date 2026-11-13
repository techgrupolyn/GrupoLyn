// Ejecutable del lote de captación ABCD (primera entrega: leads existentes). Desde backend/:
//
//   npx tsx netelip/captacion/lote-cli.ts --desde 2026-11-05 --hasta 2026-11-13 --informe C:/ruta/informe.csv
//   … --limite 20            solo las 20 primeras llamadas (prueba corta)
//   … --candidatos todos     regla del ticket tal cual (por defecto «vivos»: resuelve teléfonos repetidos si solo una tarea sigue viva)
//   … --escribir 10          escribe en ClickUp la categoría de, como máximo, 10 leads (por defecto 0 = simulacro, no escribe)
//   … --confirmo-copia       obligatorio si DATABASE_URL no es local Y con nombre de pruebas (copia, local, prueba, test, qa): confirma que es una COPIA (el lote guarda evaluaciones)
//
// Variables: DATABASE_URL, CLICKUP_API_TOKEN, CAPTACION_CLICKUP_LIST_ID y GOOGLE_GEMINI_API_KEY (o CAPTACION_GEMINI_API_KEY).
// El informe lleva nombres de leads y frases de llamadas: guárdalo fuera del repo y no lo pegues en chats.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { evaluadorGemini, type Evaluador } from '../calificador/modelo.ts';
import { ClickUpClient, clickupConfigDesdeEnv } from './clickup.ts';
import { ejecutarLote, type InformeLote } from './lote.ts';
import { ESQUEMA_SALIDA } from './prompt.ts';
import { ensureCaptacion } from './schema.ts';

export interface Argumentos {
  desde: Date;
  hasta: Date;
  candidatos: 'vivos' | 'todos';
  escribir: number;
  limite: number | undefined;
  informe: string;
  confirmoCopia: boolean;
}

const fecha = (valor: string | undefined, nombre: string): Date => {
  if (!valor || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) throw new Error(`${nombre} debe ser una fecha AAAA-MM-DD`);
  const d = new Date(`${valor}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== valor) throw new Error(`${nombre} no es una fecha válida: ${valor}`);
  return d;
};

const entero = (valor: string | undefined, nombre: string): number => {
  if (!valor || !/^\d+$/.test(valor)) throw new Error(`${nombre} debe ser un número entero (0 o más)`);
  const n = Number(valor);
  // Con muchos dígitos Number() redondea o llega a Infinity y un tope así no limitaría nada.
  if (!Number.isSafeInteger(n)) throw new Error(`${nombre} es demasiado grande`);
  return n;
};

/** Lee los argumentos; lanza un error con un mensaje claro si falta o sobra algo. `desde` es inclusive y `hasta` exclusivo, en UTC. */
export function leerArgumentos(argv: readonly string[]): Argumentos {
  const valores = new Map<string, string>();
  const banderas = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`Argumento inesperado: ${a}`);
    const nombre = a.slice(2);
    if (nombre === 'confirmo-copia') banderas.add(nombre);
    else if (['desde', 'hasta', 'informe', 'limite', 'candidatos', 'escribir'].includes(nombre)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`Falta el valor de --${nombre}`);
      valores.set(nombre, v);
      i += 1;
    } else throw new Error(`Argumento desconocido: ${a}`);
  }
  const desde = fecha(valores.get('desde'), '--desde');
  const hasta = fecha(valores.get('hasta'), '--hasta');
  if (hasta <= desde) throw new Error('--hasta debe ser posterior a --desde');
  const informe = valores.get('informe');
  if (!informe) throw new Error('Falta --informe con la ruta del archivo CSV (fuera del repo)');
  const candidatos = valores.get('candidatos') ?? 'vivos';
  if (candidatos !== 'vivos' && candidatos !== 'todos') throw new Error('--candidatos debe ser «vivos» o «todos»');
  return {
    desde, hasta, informe, candidatos,
    escribir: valores.has('escribir') ? entero(valores.get('escribir'), '--escribir') : 0,
    limite: valores.has('limite') ? entero(valores.get('limite'), '--limite') : undefined,
    confirmoCopia: banderas.has('confirmo-copia'),
  };
}

/** Excel lee como fórmula una celda que empieza por = + - @ (con o sin espacios delante) o por tabulador/salto de línea. */
const COMO_FORMULA = /^[\t\r\n]|^\s*[=+\-@]/;

const celda = (v: unknown): string => {
  const texto = v === null || v === undefined ? '' : String(v);
  // Los nombres de leads vienen de formularios web y las frases de las llamadas: no deben poder ejecutarse al abrir el CSV.
  const s = COMO_FORMULA.test(texto) ? `'${texto}` : texto;
  return /["\n\r;]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** CSV para Excel (UTF-8 con BOM, separador «;»): una fila por llamada con letra, desglose y frases citadas. */
export function informeCsv(i: InformeLote): string {
  const cabecera = ['fecha', 'llamada', 'lead', 'lead_id', 'etapa', 'via', 'estado', 'motivo', 'categoria', 'desglose', 'frases_citadas', 'descartes', 'revision_manual', 'intentos'];
  const filas = i.filas.map((f) => [
    f.ocurridaEn, f.llamadaId, f.lead?.nombre ?? '', f.lead?.id ?? '', f.lead?.etapa ?? '', f.via ?? '', f.estado, f.motivo ?? '', f.categoria ?? '', f.desglose ?? '',
    f.citas.map((c) => `${c.criterio} ${c.nivel}: «${c.cita}»`).join(' | '), f.descartes, f.revisionManual.join(' | '), f.intentos,
  ]);
  return `\uFEFF${[cabecera, ...filas].map((fila) => fila.map(celda).join(';')).join('\r\n')}\r\n`;
}

/** Resumen corto para la pantalla: solo totales, sin nombres ni frases. */
export function resumenTexto(i: InformeLote): string {
  const r = i.resumen;
  const cuentas = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(' · ') || '—';
  const escritas = i.escrituras.filter((e) => e.resultado === 'escrito').length;
  // Los ids de tarea de ClickUp no identifican a nadie: sirven para abrir la tarjeta escrita (app.clickup.com/t/<id>).
  const ids = (resultado: string) => i.escrituras.filter((e) => e.resultado === resultado).map((e) => e.clickupTaskId);
  const escritosIds = ids('escrito');
  const conErrorIds = ids('error');
  return [
    `Leads en la lista: ${r.leadsEnLista} (vivos ${r.leadsVivos}) · Alcance provisional nuevo: ${r.alcanceProvisional}`,
    `Llamadas procesadas: ${r.llamadas} → ${cuentas(r.porEstado)}`,
    `Leads calificados: ${r.leadsCalificados} → ${cuentas(r.porCategoria)}`,
    `Escritura en ClickUp: ${escritas} leads escritos · ${i.escrituras.filter((e) => e.resultado === 'simulado').length} en simulacro · ${i.escrituras.filter((e) => e.resultado === 'sin_cupo').length} sin cupo · ${i.escrituras.filter((e) => e.resultado === 'no_vivo').length} no vivos (no se escriben) · ${i.escrituras.filter((e) => e.resultado === 'error').length} con error`,
    ...(escritosIds.length ? [`Escritos (ids de ClickUp): ${escritosIds.join(', ')}`] : []),
    ...(conErrorIds.length ? [`Con error (ids de ClickUp): ${conErrorIds.join(', ')}`] : []),
  ].join('\n');
}

/**
 * ¿Parece una base de pruebas? Local Y con «copia», «local», «prueba», «test» o «qa» en el nombre. Solo «local» no
 * basta: un túnel SSH hacia producción también escucha en 127.0.0.1.
 */
export const baseParecePruebas = (url: string): boolean => {
  try {
    const u = new URL(url);
    const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
    return local && /(copia|local|prueba|test|qa)/i.test(decodeURIComponent(u.pathname.slice(1)));
  } catch {
    return false;
  }
};

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const a = leerArgumentos(argv);
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('Falta DATABASE_URL (usa una copia de la base, nunca la de producción)');
  if (!baseParecePruebas(databaseUrl) && !a.confirmoCopia) {
    throw new Error('DATABASE_URL no parece una base de pruebas (local y con «copia», «local», «prueba», «test» o «qa» en el nombre; un túnel hacia producción también es local). El lote guarda evaluaciones en las tablas de la captación: usa una COPIA de la base y repite con --confirmo-copia.');
  }
  const config = clickupConfigDesdeEnv(env);
  if (!config) throw new Error('Faltan CLICKUP_API_TOKEN y/o CAPTACION_CLICKUP_LIST_ID');
  const modelo = evaluadorGemini(
    { ...env, GOOGLE_GEMINI_API_KEY: env.CAPTACION_GEMINI_API_KEY?.trim() || env.GOOGLE_GEMINI_API_KEY, CALIFICADOR_MODEL: env.CAPTACION_MODEL?.trim() || env.CALIFICADOR_MODEL },
    fetch, { schema: ESQUEMA_SALIDA, maxOutputTokens: 4096 },
  );
  if (!modelo) console.warn('Sin clave de Gemini (GOOGLE_GEMINI_API_KEY o CAPTACION_GEMINI_API_KEY): las llamadas con lead quedarán como fallo del modelo.');
  const evaluar: Evaluador = modelo ?? (async () => { throw new Error('sin clave de Gemini'); });

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await ensureCaptacion(pool);
    const informe = await ejecutarLote({
      pool, cliente: new ClickUpClient(config), evaluar, desde: a.desde, hasta: a.hasta, candidatos: a.candidatos,
      escribirMaximo: a.escribir, limite: a.limite, registro: (m) => console.log(m),
    });
    writeFileSync(a.informe, informeCsv(informe), 'utf8');
    console.log(resumenTexto(informe));
    console.log(`Informe: ${a.informe}`);
    return 0;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((codigo) => process.exit(codigo), (error) => {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  });
}
