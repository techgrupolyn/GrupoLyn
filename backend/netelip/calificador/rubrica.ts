// Rúbricas versionadas del calificador (ticket 869fpj8dm): la rúbrica vive en la tabla rubrica_version,
// no en el código. El prompt y el esquema de salida se construyen desde la versión, así que publicar un
// guion nuevo no exige desplegar. Un rol sin versión activa sigue con la rúbrica fija fase0-v1 (rubrica-v1.md).
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { ROLES_COMERCIALES, type RolComercial } from './schema.ts';
import { TIPOS_OBJECION } from './reglas.ts';

export type Criterio = { paso: number; nombre: string; peso: number; descripcion: string };
export type ErrorDefinido = { codigo: string; nombre: string; descripcion: string };
export type DefinicionRubrica = {
  codigo: string; rol: RolComercial; version: number; fuente: string; nota_apto: number; objetivo: string;
  criterios: Criterio[]; errores_criticos: ErrorDefinido[]; reglas: string[];
};
export type RubricaVersion = DefinicionRubrica & { id: string; activo: boolean };

export class RubricaInvalida extends Error {}

const texto = (v: unknown, campo: string, max: number) => {
  if (typeof v !== 'string' || !v.trim()) throw new RubricaInvalida(`${campo}: obligatorio`);
  if (v.length > max) throw new RubricaInvalida(`${campo}: más de ${max} caracteres`);
  return v.trim();
};

/** Valida una definición (archivo JSON o fila de la base). Los pesos suman 100 y los códigos son únicos. */
export function validarDefinicion(raw: unknown): DefinicionRubrica {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rol = d.rol as RolComercial;
  if (!ROLES_COMERCIALES.includes(rol)) throw new RubricaInvalida(`rol: usa ${ROLES_COMERCIALES.join(', ')}`);
  const version = Number(d.version);
  if (!Number.isInteger(version) || version < 1) throw new RubricaInvalida('version: entero ≥ 1');
  const codigo = texto(d.codigo, 'codigo', 40);
  if (!/^[a-z0-9_]+-v\d+$/.test(codigo)) throw new RubricaInvalida('codigo: formato «rol-vN», p. ej. sdr-v2');
  const notaApto = Number(d.nota_apto ?? 80);
  if (!Number.isInteger(notaApto) || notaApto < 1 || notaApto > 100) throw new RubricaInvalida('nota_apto: entero de 1 a 100');
  const criterios = Array.isArray(d.criterios) ? d.criterios : [];
  if (criterios.length < 1 || criterios.length > 15) throw new RubricaInvalida('criterios: de 1 a 15 pasos');
  const pasos = criterios.map((c, i) => {
    const r = (c || {}) as Record<string, unknown>;
    const peso = Number(r.peso);
    if (!Number.isInteger(peso) || peso < 1) throw new RubricaInvalida(`criterios[${i}].peso: entero ≥ 1`);
    return { paso: i + 1, nombre: texto(r.nombre, `criterios[${i}].nombre`, 80), peso, descripcion: texto(r.descripcion, `criterios[${i}].descripcion`, 1500) };
  });
  const suma = pasos.reduce((n, p) => n + p.peso, 0);
  if (suma !== 100) throw new RubricaInvalida(`criterios: los pesos suman ${suma}, deben sumar 100`);
  const errores = (Array.isArray(d.errores_criticos) ? d.errores_criticos : []).map((e, i) => {
    const r = (e || {}) as Record<string, unknown>;
    const codigoError = texto(r.codigo, `errores_criticos[${i}].codigo`, 40);
    if (!/^[A-Z][A-Z0-9_]*$/.test(codigoError)) throw new RubricaInvalida(`errores_criticos[${i}].codigo: MAYÚSCULAS_Y_GUIONES`);
    return { codigo: codigoError, nombre: texto(r.nombre, `errores_criticos[${i}].nombre`, 80), descripcion: texto(r.descripcion, `errores_criticos[${i}].descripcion`, 1500) };
  });
  if (new Set(errores.map((e) => e.codigo)).size !== errores.length) throw new RubricaInvalida('errores_criticos: códigos repetidos');
  const reglas = (Array.isArray(d.reglas) ? d.reglas : []).map((x, i) => texto(x, `reglas[${i}]`, 600));
  return { codigo, rol, version, fuente: texto(d.fuente, 'fuente', 400), nota_apto: notaApto, objetivo: texto(d.objetivo, 'objetivo', 1000), criterios: pasos, errores_criticos: errores, reglas };
}

/** Versión inicial del SDR, que se carga sola si el rol aún no tiene ninguna. */
export const RUBRICA_SDR_V1 = validarDefinicion(JSON.parse(readFileSync(new URL('./rubricas/sdr-v1.json', import.meta.url), 'utf8')));

// --- Base de datos ----------------------------------------------------------------------------

type Fila = { id: string; codigo: string; rol: RolComercial; version: number; fuente: string; nota_apto: number; objetivo: string;
  criterios: Criterio[]; errores_criticos: ErrorDefinido[]; reglas: string[]; activo: boolean };
const COLUMNAS = 'id, codigo, rol, version, fuente, nota_apto, objetivo, criterios, errores_criticos, reglas, activo';
const desdeFila = (f: Fila): RubricaVersion => ({ ...f, id: String(f.id), version: Number(f.version), nota_apto: Number(f.nota_apto) });

export async function rubricaPorId(pool: Pool, id: string | number): Promise<RubricaVersion | null> {
  const { rows: [f] } = await pool.query<Fila>(`SELECT ${COLUMNAS} FROM rubrica_version WHERE id = $1`, [id]);
  return f ? desdeFila(f) : null;
}

export async function rubricaPorCodigo(pool: Pool, codigo: string): Promise<RubricaVersion | null> {
  const { rows: [f] } = await pool.query<Fila>(`SELECT ${COLUMNAS} FROM rubrica_version WHERE codigo = $1`, [codigo]);
  return f ? desdeFila(f) : null;
}

export async function listarRubricas(pool: Pool): Promise<RubricaVersion[]> {
  const { rows } = await pool.query<Fila>(`SELECT ${COLUMNAS} FROM rubrica_version ORDER BY rol, version`);
  return rows.map(desdeFila);
}

/**
 * Publica una versión nueva. Con `activar`, pasa a ser la vigente del rol en la misma transacción:
 * desde ese momento las llamadas nuevas se encolan con ella. Las evaluaciones anteriores no cambian.
 */
export async function publicarRubrica(pool: Pool, definicion: DefinicionRubrica, opciones: { activar: boolean; autor?: string }): Promise<RubricaVersion> {
  const d = validarDefinicion(definicion);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (opciones.activar) await client.query('UPDATE rubrica_version SET activo = FALSE WHERE rol = $1 AND activo', [d.rol]);
    const { rows: [f] } = await client.query<Fila>(
      `INSERT INTO rubrica_version (codigo, rol, version, fuente, nota_apto, objetivo, criterios, errores_criticos, reglas, activo, vigente_desde, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $10 THEN NOW() END, $11) RETURNING ${COLUMNAS}`,
      [d.codigo, d.rol, d.version, d.fuente, d.nota_apto, d.objetivo, JSON.stringify(d.criterios), JSON.stringify(d.errores_criticos), JSON.stringify(d.reglas), opciones.activar, opciones.autor ?? null]);
    await client.query('COMMIT');
    return desdeFila(f);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((error as { code?: string }).code === '23505') throw new RubricaInvalida(`ya existe una rúbrica ${d.codigo} o la versión ${d.version} de ${d.rol}`);
    throw error;
  } finally { client.release(); }
}

/** Carga la v1 del SDR la primera vez (si el rol no tiene ninguna versión). Idempotente. */
export async function sembrarRubricas(pool: Pool): Promise<void> {
  const d = RUBRICA_SDR_V1;
  await pool.query(
    `INSERT INTO rubrica_version (codigo, rol, version, fuente, nota_apto, objetivo, criterios, errores_criticos, reglas, activo, vigente_desde, creado_por)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, NOW(), 'carga inicial'
     WHERE NOT EXISTS (SELECT 1 FROM rubrica_version WHERE rol = $2)
     ON CONFLICT DO NOTHING`,
    [d.codigo, d.rol, d.version, d.fuente, d.nota_apto, d.objetivo, JSON.stringify(d.criterios), JSON.stringify(d.errores_criticos), JSON.stringify(d.reglas)]);
}

/** Deja una versión existente como la vigente de su rol. */
export async function activarRubrica(pool: Pool, codigo: string): Promise<RubricaVersion> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [f] } = await client.query<Fila>(`SELECT ${COLUMNAS} FROM rubrica_version WHERE codigo = $1 FOR UPDATE`, [codigo]);
    if (!f) throw new RubricaInvalida(`no existe la rúbrica ${codigo}`);
    await client.query('UPDATE rubrica_version SET activo = FALSE WHERE rol = $1 AND activo', [f.rol]);
    await client.query('UPDATE rubrica_version SET activo = TRUE, vigente_desde = NOW() WHERE id = $1', [f.id]);
    await client.query('COMMIT');
    return desdeFila({ ...f, activo: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

// --- Prompt y esquema desde la versión -------------------------------------------------------

/** Esquema JSON de la salida: los errores y los pasos posibles salen de la versión. */
export function esquemaSalida(r: DefinicionRubrica) {
  return {
    type: 'object',
    properties: {
      llamada_evaluable: { type: 'boolean' },
      motivo_no_evaluable: { type: ['string', 'null'] },
      pasos: { type: 'array', items: { type: 'object', properties: {
        paso: { type: 'integer', minimum: 1, maximum: r.criterios.length }, aplica: { type: 'boolean' },
        puntos: { type: 'integer', minimum: 0, maximum: Math.max(...r.criterios.map((c) => c.peso)) }, comentario: { type: 'string' },
      }, required: ['paso', 'aplica', 'puntos', 'comentario'] } },
      errores_criticos: { type: 'array', items: { type: 'object', properties: {
        regla: { type: 'string', enum: r.errores_criticos.map((e) => e.codigo) }, cita: { type: 'string' }, marca_tiempo: { type: 'string' },
      }, required: ['regla', 'cita', 'marca_tiempo'] } },
      bien: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
      mejorar: { type: 'array', items: { type: 'object', properties: { que: { type: 'string' }, accion: { type: 'string' } }, required: ['que', 'accion'] }, minItems: 2, maxItems: 2 },
      duda: { type: 'object', properties: { valor: { type: 'boolean' }, motivo: { type: ['string', 'null'] } }, required: ['valor', 'motivo'] },
      objeciones: { type: 'array', items: { type: 'object', properties: {
        tipo: { type: 'string', enum: [...TIPOS_OBJECION] }, cita: { type: 'string' }, idea_contenido: { type: ['string', 'null'] },
      }, required: ['tipo', 'cita', 'idea_contenido'] } },
    },
    required: ['llamada_evaluable', 'motivo_no_evaluable', 'pasos', 'errores_criticos', 'bien', 'mejorar', 'duda', 'objeciones'],
  };
}

const ROL_TEXTO: Record<RolComercial, string> = { sdr: 'SDR (primera llamada, Fase 0)', closer_f2: 'closer de Fase 2', closer_f3: 'closer de Fase 3' };

/** Instrucciones del sistema: partes fijas (citas, evaluabilidad, salida) + la rúbrica de la versión. */
export function promptVersionado(r: DefinicionRubrica): string {
  const pasos = r.criterios.map((c) => `**Paso ${c.paso} · ${c.nombre} (${c.peso} puntos).** ${c.descripcion}`).join('\n\n');
  const errores = r.errores_criticos.map((e) => `- **${e.codigo}** (${e.nombre}): ${e.descripcion}`).join('\n');
  const reglas = r.reglas.map((x) => `- ${x}`).join('\n');
  return `# Calificador interno de llamadas · Grupo LYN · ${ROL_TEXTO[r.rol]} · rúbrica ${r.codigo}

Fuente de la rúbrica: ${r.fuente}.

## Tu tarea

Evalúas cómo hizo una llamada REAL un comercial de Grupo LYN (no al cliente) y devuelves SOLO el JSON del esquema. Tu evaluación es orientativa: la revisa una persona cuando hay escalado.

La transcripción viene por turnos: \`[hh:mm:ss] GRUPO LYN:\` es el comercial y \`[hh:mm:ss] CLIENTE:\` el cliente. ATENCIÓN: en las grabaciones reales estas etiquetas fallan a menudo (turnos atribuidos al hablante contrario, cambios a mitad de frase o la llamada entera invertida). Decide siempre quién habla por el CONTENIDO (quien presenta la empresa, propone la sesión o da la horquilla es el comercial) y usa la etiqueta solo como pista. Si no puedes saber quién dijo la frase que sostendría un error crítico, no lo marques: marca duda. Los datos personales vienen sustituidos por marcadores como [NOMBRE], [TELÉFONO], [EMAIL], [DIRECCIÓN] o [DNI]: no intentes reconstruirlos. La transcripción es automática y puede tener palabras mal reconocidas: no penalices por errores evidentes de transcripción.

## Objetivo de la llamada

${r.objetivo}

## Reglas para las citas

- Cada error crítico y cada objeción lleva una \`cita\` COPIADA LITERALMENTE de la transcripción: una frase o fragmento continuo, de 4 a 30 palabras, sin cambiar ni corregir nada. El código comprueba que la cita aparece tal cual; si no aparece, el error se descarta.
- \`marca_tiempo\` es el minuto del turno de la cita en formato hh:mm:ss.
- Si sospechas un error crítico pero no hay una frase que lo demuestre, NO lo marques: pon \`duda.valor = true\` y explica el motivo en una frase.
- Evalúa solo lo que se dijo, nunca lo que «quizá quiso decir».

## ¿Es una llamada evaluable?

Pon \`llamada_evaluable = false\` (con \`motivo_no_evaluable\`) cuando NO sea una conversación comercial con un cliente o lead: buzón de voz, llamada cortada antes de hablar del proyecto, número equivocado, proveedor, gestión interna, candidato de empleo, cliente en obra o postventa. En ese caso, pasos con aplica = false y puntos = 0, bien y mejorar con frases breves genéricas y sin errores críticos.

## Rúbrica: ${r.criterios.length} pasos, ${r.criterios.reduce((n, c) => n + c.peso, 0)} puntos

${pasos}

Puntúa cada paso en \`pasos\` (uno por paso, del 1 al ${r.criterios.length}) con \`puntos\` entre 0 y su peso, según la evidencia real; no des el máximo por defecto. Si por el tipo de llamada un paso no corresponde (una rellamada que solo cierra la fecha no repite la apertura ni la horquilla; una llamada cortada no llega al final), pon \`aplica = false\` y \`puntos = 0\`: el código reparte los 100 puntos entre los pasos que sí aplican. \`comentario\`: una frase de 15 palabras máximo con la evidencia. NO calculas la nota total: la calcula el código.

${reglas ? `### Reglas de puntuación\n\n${reglas}\n\n` : ''}## Errores críticos (con cita literal obligatoria)

${errores}

## Qué devuelves

- \`bien\`: exactamente 2 aciertos concretos de ESTA llamada, de 8 palabras como máximo cada uno (se leen en el móvil). Nada de elogios genéricos.
- \`mejorar\`: exactamente 2 mejoras, cada una con \`que\` (8 palabras máx.) y \`accion\` (qué hacer en la próxima llamada, 14 palabras máx.), priorizando los errores críticos. Tutea al comercial.
- \`objeciones\`: las objeciones o preocupaciones del CLIENTE con su cita literal y su \`tipo\` (precio, plazo, confianza, decisor, otra). Si merece contenido de marketing (post, vídeo, FAQ, caso), propón la idea en \`idea_contenido\` en una frase; si no, null. Nunca incluyas datos del cliente ni marcadores en la idea.
- \`duda\`: verdadero si la evidencia no basta para decidir sobre un error crítico o la llamada es atípica, con el motivo en una frase.
- El código decide APTO (≥ ${r.nota_apto} sin error crítico) y el escalado: tú no los calculas.`;
}
