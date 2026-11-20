// Ejecutable de la carga inicial de la captación ABCD. Desde backend/:
//
//   npx tsx netelip/captacion/carga-inicial-cli.ts --informe C:/ruta/informe.csv --confirmo-copia
//   … --escribir 10     escribe en ClickUp lo que falte en, como máximo, 10 tarjetas (por defecto 0 = simulacro, no escribe)
//   … --confirmo-copia  obligatorio si DATABASE_URL no es local Y con nombre de pruebas (copia, local, prueba, test, qa)
//   … --base-real       en vez del anterior: confirma que DATABASE_URL es la base REAL y que ya tiene (o puede crear) las tablas de la captación
//
// Variables: DATABASE_URL, CLICKUP_API_TOKEN y CAPTACION_CLICKUP_LIST_ID. No usa Gemini.
// Repetirlo no duplica nada: solo da de alta a los leads nuevos y completa lo que falte en las tarjetas.
// El informe lleva nombres de leads: guárdalo fuera del repo y no lo pegues en chats.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { ClickUpClient, clickupConfigDesdeEnv } from './clickup.ts';
import { ejecutarCargaInicial, type InformeCarga } from './carga-inicial.ts';
import { baseParecePruebas, celda } from './lote-cli.ts';
import { ensureCaptacion } from './schema.ts';

export interface ArgumentosCarga {
  informe: string;
  escribir: number;
  confirmoCopia: boolean;
  baseReal: boolean;
}

/** Lee los argumentos; lanza un error con un mensaje claro si falta o sobra algo. */
export function leerArgumentosCarga(argv: readonly string[]): ArgumentosCarga {
  const valores = new Map<string, string>();
  const banderas = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`Argumento inesperado: ${a}`);
    const nombre = a.slice(2);
    if (nombre === 'confirmo-copia' || nombre === 'base-real') banderas.add(nombre);
    else if (nombre === 'informe' || nombre === 'escribir') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`Falta el valor de --${nombre}`);
      valores.set(nombre, v);
      i += 1;
    } else throw new Error(`Argumento desconocido: ${a}`);
  }
  const informe = valores.get('informe');
  if (!informe) throw new Error('Falta --informe con la ruta del archivo CSV (fuera del repo)');
  let escribir = 0;
  if (valores.has('escribir')) {
    const v = valores.get('escribir');
    // Con muchos dígitos Number() redondea o llega a Infinity y un tope así no limitaría nada.
    if (!v || !/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error('--escribir debe ser un número entero normal (0 o más)');
    escribir = Number(v);
  }
  if (banderas.has('confirmo-copia') && banderas.has('base-real')) throw new Error('--confirmo-copia y --base-real se excluyen: o es una copia o es la base real');
  return { informe, escribir, confirmoCopia: banderas.has('confirmo-copia'), baseReal: banderas.has('base-real') };
}

/** CSV para Excel (UTF-8 con BOM, separador «;»): una fila por lead vivo; «sin_presupuesto» = sí es el listado que se entrega. */
export function informeCsvCarga(i: InformeCarga): string {
  const cabecera = ['lead_id', 'lead', 'etapa', 'accion', 'categoria', 'presupuesto', 'fuente', 'ponderado', 'sin_presupuesto', 'escritura', 'campos', 'detalle'];
  const filas = i.filas.map((f) => [
    f.clickupTaskId, f.nombre, f.etapa ?? '', f.accion, f.categoria, f.presupuesto ?? '', f.fuente, f.ponderado ?? '', f.sinPresupuesto ? 'sí' : 'no', f.escritura, f.campos, f.detalle ?? '',
  ]);
  return `\uFEFF${[cabecera, ...filas].map((fila) => fila.map(celda).join(';')).join('\r\n')}\r\n`;
}

/** Resumen corto para la pantalla: solo totales, sin nombres. */
export function resumenCarga(i: InformeCarga): string {
  const r = i.resumen;
  const cuentas = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(' · ') || '—';
  const errores = i.filas.filter((f) => f.escritura === 'error');
  const motivos = [...new Set(errores.map((f) => f.detalle ?? 'sin detalle'))].slice(0, 3);
  return [
    `Leads en la lista: ${r.leadsEnLista} (vivos ${r.leadsVivos}) · Altas nuevas: ${r.altas} · Ya cargadas: ${r.yaCargadas} · Sin presupuesto: ${r.sinPresupuesto}`,
    `Por categoría: ${cuentas(r.porCategoria)}`,
    `Escritura en ClickUp: ${r.escritos} tarjetas escritas · ${r.simulados} en simulacro · ${r.sinCupo} sin cupo · ${r.alDia} ya al día · ${r.errores} con error`,
    ...(motivos.length ? [`Motivos de error: ${motivos.join(' | ')}`] : []),
  ].join('\n');
}

export async function mainCarga(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const a = leerArgumentosCarga(argv);
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('Falta DATABASE_URL (usa una copia de la base la primera vez)');
  if (!a.baseReal && !baseParecePruebas(databaseUrl) && !a.confirmoCopia) {
    throw new Error('DATABASE_URL no parece una base de pruebas (local y con «copia», «local», «prueba», «test» o «qa» en el nombre; un túnel hacia producción también es local). La carga guarda las altas en las tablas de la captación: usa una COPIA de la base y repite con --confirmo-copia, o, si es la base real, con --base-real.');
  }
  const config = clickupConfigDesdeEnv(env);
  if (!config) throw new Error('Faltan CLICKUP_API_TOKEN y/o CAPTACION_CLICKUP_LIST_ID');

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await ensureCaptacion(pool);
    const informe = await ejecutarCargaInicial({ pool, cliente: new ClickUpClient(config), escribirMaximo: a.escribir, registro: (m) => console.log(m) });
    writeFileSync(a.informe, informeCsvCarga(informe), 'utf8');
    console.log(resumenCarga(informe));
    console.log(`Informe: ${a.informe}`);
    return 0;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mainCarga(process.argv.slice(2)).then((codigo) => process.exit(codigo), (error) => {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  });
}
