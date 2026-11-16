export type ProtocolPrivacyContext = { clientNames?: string[]; clientAddresses?: string[] };

// --- Direcciones postales ---------------------------------------------------------------------
// Tipo de vía + nombre + número, con portal, piso, puerta y código postal opcionales, también en mitad de una frase.
// Para no tapar frases como «la calle está cortada» o «la plaza a las 10»: el nombre de la vía empieza en mayúscula;
// en minúsculas solo se tapa con abreviatura (c/, avda.…) o con una marca inequívoca («nº 23», «23, 3ºB», «piso 2»).
// Sin número no se tapa: «vive en la calle Mayor» no es una dirección postal completa.
// Límite conocido: los números dichos con letras («calle Mayor veintitrés») no se detectan.

/** «calle» → «[cC][aA]…»: el tipo de vía no distingue mayúsculas; el nombre de la vía sí. */
const anyCase = (value: string) => value.replace(/\p{L}/gu, letter => `[${letter.toLowerCase()}${letter.toUpperCase()}]`).replace(/[./]/g, '\\$&');
const STREET_WORDS = ['calle', 'carrer', 'avenida', 'avinguda', 'plaza', 'plaça', 'paseo', 'passeig', 'camino', 'camí', 'carretera', 'ronda', 'travesía', 'travesia',
  'urbanización', 'urbanizacion', 'partida', 'polígono', 'poligono', 'glorieta', 'pasaje', 'callejón', 'bulevar', 'rambla'];
const STREET_ABBREVIATIONS = ['c/', 'cl.', 'avda.', 'avd.', 'av.', 'pza.', 'pl.', 'pº', 'ctra.', 'trav.', 'urb.', 'pda.', 'pol.', 'psje.'];
const BEFORE = String.raw`(?<![\p{L}\d])`;
const STREET_WORD = String.raw`(?:${STREET_WORDS.map(anyCase).join('|')})(?![\p{L}])`;
const STREET_ABBREVIATION = `(?:${STREET_ABBREVIATIONS.map(anyCase).join('|')})`;
const CONNECTOR = "(?:de|del|la|las|los|el|d'|l'|y|i)";
const CAPITALIZED = String.raw`(?:\p{Lu}[\p{L}'’.-]*|\[NOMBRE\])`;
const ANY_WORD = String.raw`\p{L}[\p{L}'’.-]*`;
const NAME_CAPITALIZED = String.raw`(?:${CONNECTOR}\s+)*${CAPITALIZED}(?:\s+(?:${CONNECTOR}|${CAPITALIZED})){0,5}`;
const NAME_ANY = String.raw`${ANY_WORD}(?:\s+${ANY_WORD}){0,5}`;
const NUMBER_MARK = String.raw`(?:[nN][º°oª]\.?\s*|[nN][úu]mero\s+|[nN]um\.\s*|[kK]m\.?\s*|[kK]il[óo]metro\s+)`;
const NUMBER = String.raw`(?:\d{1,4}(?:\s?[A-Z]|[a-z])?(?:\s*bis)?(?![\p{L}\d])|[sS]\/[nN](?![\p{L}]))`;
const SIDE = String.raw`(?:[A-Za-z](?![\p{L}])|izq(?:uierda|\.)?|dcha\.?|der(?:echa|\.)?|centro|ctro\.?)`;
const FLOOR = [
  String.raw`\d{1,2}\s*[º°ª]\s*${SIDE}?`,
  String.raw`(?:piso|planta|puerta|pta\.?|portal|escalera|esc\.|bloque|blq\.?|nave|local|parcela)\s+(?:\d{1,3}\s*[º°ª]?\s*[A-Za-z]?|[A-Z]|izquierda|derecha)(?![\p{L}\d])`,
  String.raw`(?:bajo|ático|atico|entresuelo|principal)(?:\s*[A-Z])?(?![\p{L}])`,
  String.raw`(?:primero|segundo|tercero|cuarto|quinto|sexto|séptimo|octavo|noveno|décimo)(?:\s+${SIDE})?(?![\p{L}])`,
].join('|');
// Código postal español: 5 dígitos de 01000 a 52999.
const POSTAL_CODE = String.raw`(?:0[1-9]|[1-4]\d|5[0-2])\d{3}(?!\d)`;
const POSTAL_TAIL = String.raw`\s*,?\s*(?:[cC]\.?[pP]\.?\s*)?${POSTAL_CODE}`;
const FLOOR_TAIL = String.raw`\s*[,-]?\s*(?:${FLOOR})`;
const TAIL = `(?:${FLOOR_TAIL}){0,4}(?:${POSTAL_TAIL})?`;
const TAIL_REQUIRED = `(?:(?:${FLOOR_TAIL}){1,4}(?:${POSTAL_TAIL})?|${POSTAL_TAIL})`;

const addressPatterns = [
  // Nombre en mayúscula: «Calle Mayor 23, 3ºB», «Avenida de la Estación nº 45», «Plaza de España 3, 03001».
  String.raw`${BEFORE}(?:${STREET_WORD}|${STREET_ABBREVIATION})\s*${NAME_CAPITALIZED}\s*,?\s*${NUMBER_MARK}?${NUMBER}${TAIL}`,
  // Abreviatura de vía con el nombre en minúsculas: «c/ mayor 23».
  String.raw`${BEFORE}${STREET_ABBREVIATION}\s*${NAME_ANY}\s*,?\s*${NUMBER_MARK}?${NUMBER}${TAIL}`,
  // Todo en minúsculas: solo con «nº/número» delante o con piso, puerta o código postal detrás.
  String.raw`${BEFORE}${STREET_WORD}\s*${NAME_ANY}\s*,?\s*(?:${NUMBER_MARK}${NUMBER}${TAIL}|${NUMBER}${TAIL_REQUIRED})`,
  // Fincas rústicas: «polígono 5, parcela 23».
  String.raw`${BEFORE}${anyCase('polígono')}\s+\d{1,3}\s*,?\s*${anyCase('parcela')}\s+\d{1,4}(?!\d)`,
  // Código postal suelto: tras «código postal» o «CP», o empezando por 0 (así no se confunde con un importe).
  String.raw`(?<=(?:${anyCase('código postal')}|${anyCase('codigo postal')}|${BEFORE}[cC]\.?[pP]\.?)\s*:?\s*(?:es\s+)?(?:el\s+)?)${POSTAL_CODE}`,
  String.raw`(?<![\d.,])0[1-9]\d{3}(?![\d.,]?\d)`,
].map((source): [RegExp, string] => [new RegExp(source, 'gu'), '[DIRECCIÓN]']);

const personalPatterns: Array<[RegExp, string]> = [
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[EMAIL]'],
  [/\bES\d{2}(?:[\s-]*\d{4}){5}\b/giu, '[IBAN]'],
  [/\b\d{8}[A-Z]\b|\b[XYZ]\d{7}[A-Z]\b/giu, '[DNI]'],
  [/(?<!\w)(?:\+|00)\d{1,3}(?:[\s.-]?\d){7,14}(?!\w)|(?<!\w)[679](?:[\s.-]?\d){8}(?!\w)/gu, '[TELÉFONO]'],
  ...addressPatterns,
];

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Variantes de una dirección guardada para buscarla en un texto hablado: la dirección tal cual, «nombre de la vía +
 * número» (el tipo de vía se dice de muchas formas) y el nombre solo si tiene al menos dos palabras con contenido
 * («San Vicente Mártir»; «Mayor» a secas taparía también la palabra común).
 */
export function addressVariants(address: string): string[] {
  const clean = String(address || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 6) return [];
  const withoutType = clean.replace(new RegExp(`^(?:${STREET_WORD}|${STREET_ABBREVIATION})\\s*`, 'u'), '');
  const match = withoutType.match(/^([^\d,]*\p{L}[^\d,]*?)\s*,?\s*(\d{1,4}[a-z]?)?(?!\d)/iu);
  const name = (match?.[1] || '').replace(/\s+(?:n[º°o]\.?|número)$/iu, '').trim();
  const number = match?.[2] || '';
  const meaningful = name.split(/\s+/).filter(word => word.length >= 3 && !/^(?:del|las|los)$/iu.test(word));
  return [clean, ...(name && number ? [`${name} ${number}`] : []), ...(meaningful.length >= 2 ? [name] : [])];
}

export function maskProtocolQuestion(question: string, context: ProtocolPrivacyContext = {}): string {
  let masked = question;
  // Direcciones guardadas antes que los nombres (el nombre del cliente puede coincidir con el de la calle);
  // con el tipo de vía delante opcional y separadores flexibles («Mayor 23» tapa «calle Mayor, nº 23»).
  const addresses = [...new Set((context.clientAddresses || []).flatMap(addressVariants))].sort((left, right) => right.length - left.length);
  for (const address of addresses) {
    const flexible = escapePattern(address).replace(/,?\s+(?=\d)/g, String.raw`\s*,?\s*(?:n[º°o]\.?\s*|número\s+)?`).replace(/,?\s+/g, String.raw`\s*,?\s*`);
    masked = masked.replace(new RegExp(String.raw`${BEFORE}(?:(?:${STREET_WORD}|${STREET_ABBREVIATION})\s*)?${flexible}(?![\p{L}\d])`, 'giu'), '[DIRECCIÓN]');
  }
  const names = [...new Set(context.clientNames || [])].filter(name => name.trim().length >= 4).sort((left, right) => right.length - left.length);
  for (const name of names) masked = masked.replace(new RegExp(`(?<![\\p{L}])${escapePattern(name)}(?![\\p{L}])`, 'giu'), '[NOMBRE]');
  for (const [pattern, marker] of personalPatterns) masked = masked.replace(pattern, marker);
  return masked;
}

export function containsUnmaskedPersonalData(text: string): boolean {
  return personalPatterns.some(([pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function canReadProtocolLog(role: unknown): boolean {
  const normalized = String(role || '').normalize('NFD').replace(/[\u0300-\u036f]/gu, '').trim().toLowerCase().replace(/[\s/-]+/gu, '_');
  return ['superadmin', 'admin', 'employee:director', 'employee:director_general', 'employee:director_de_operaciones', 'employee:direccion_de_operaciones'].includes(normalized);
}

export function canReadRestrictedProtocol(role: unknown): boolean {
  return canReadProtocolLog(role) || String(role || '').trim().toLowerCase() === 'ceo';
}

export async function hasClubAdminRole(
  query: (sql: string, params: [number]) => Promise<{ rows: Array<{ allowed: boolean }> }>,
  sessionId: number | undefined,
): Promise<boolean> {
  if (!Number.isSafeInteger(sessionId) || !sessionId || sessionId <= 0) return false;
  const result = await query(`
    SELECT EXISTS (
      SELECT 1 FROM usuarios account
      JOIN LATERAL (
        SELECT id FROM empleados
        WHERE LOWER(email) = LOWER(account.email) AND activo = TRUE
        ORDER BY id LIMIT 1
      ) employee ON TRUE
      JOIN usuario_rol assignment ON assignment.empleado_id = employee.id
      WHERE account.id = $1 AND account.auth_provider = 'supabase' AND account.activo = TRUE
        AND assignment.rol_id IN ('admin', 'superadmin')
    ) AS allowed`, [sessionId]);
  return result.rows[0]?.allowed === true;
}

export function canReadProtocolReport(role: unknown): boolean {
  const normalized = String(role || '').normalize('NFD').replace(/[\u0300-\u036f]/gu, '').trim().toLowerCase().replace(/[\s/-]+/gu, '_');
  return canReadProtocolLog(role) || normalized === 'employee:gerente_tecnico';
}
