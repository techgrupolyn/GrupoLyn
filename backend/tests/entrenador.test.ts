// Documento del entrenador de llamadas: escenarios sin base de datos, Gemini ni Google Drive reales.
import { describe, expect, it } from 'vitest';
import {
  aplicarPropuesta, bloquesDelDocumento, MAX_OBJECIONES, propuestaVacia, PropuestaInvalida, validarPropuesta, type Propuesta,
} from '../netelip/entrenador/documento.ts';
import { documentoDocx } from '../netelip/entrenador/docx.ts';
import { idCarpetaDrive, publicarDocx } from '../netelip/entrenador/drive.ts';
import { citasDelPeriodo, promptUsuario, type LlamadaPeriodo } from '../netelip/entrenador/modelo.ts';
import { DOCUMENTO_BASE } from '../netelip/entrenador/schema.ts';

const LLAMADA: LlamadaPeriodo = {
  id: '1', rol: 'closer_f2', direccion: 'outbound', duracion: 900, nota: 62, apto: false,
  errores: [{ regla: 'REGLA_CERO', cita: 'lo hablo con mi mujer y te envío un WhatsApp' }],
  mejorar: [{ que: 'Cerraste sin fecha', accion: 'Propón dos huecos y una llamada de control' }],
  objeciones: [{ tipo: 'confianza', cita: 'Tengo un amigo aparejador que vino a dar un vistazo', idea_contenido: null }],
};
const CITAS = citasDelPeriodo([LLAMADA]);
const PERIODO = { desde: new Date('2026-11-01T10:00:00Z'), hasta: new Date('2026-11-08T18:00:00Z'), llamadas: 1 };

const propuesta = (over: Partial<Propuesta> = {}): Propuesta => ({
  resumen: 'Aparecen asesores propios del cliente.',
  objeciones: [{ objecion: 'Tengo un amigo aparejador que ya lo ha visto', criterio: 'Recoger su opinión sin descalificarla y no elegir solución por teléfono.', cita: 'Tengo un amigo aparejador que vino a dar un vistazo' }],
  arquetipos: [{ arquetipo: 'E', material: '«Lo hablo con mi mujer y te envío un WhatsApp».' }],
  frases: [{ situacion: 'Decisión en pareja', frase: 'Os envío el resumen y os llamo el jueves a las 18:00 a los dos.' }],
  ...over,
});

describe('Entrenador · propuesta del modelo', () => {
  it('acepta una propuesta válida y conserva las citas que aparecen en las llamadas', () => {
    const p = validarPropuesta(JSON.stringify(propuesta()), CITAS);
    expect(p.objeciones[0].cita).toBe('Tengo un amigo aparejador que vino a dar un vistazo');
    expect(p.arquetipos).toEqual([{ arquetipo: 'E', material: '«Lo hablo con mi mujer y te envío un WhatsApp».' }]);
    expect(propuestaVacia(p)).toBe(false);
  });

  it('quita una cita inventada pero mantiene la objeción', () => {
    const p = validarPropuesta(JSON.stringify(propuesta({ objeciones: [{ objecion: 'Es muy caro', criterio: 'Dar la referencia de LYN con transparencia.', cita: 'Esto no lo dijo nadie en ninguna llamada' }] })), CITAS);
    expect(p.objeciones).toEqual([{ objecion: 'Es muy caro', criterio: 'Dar la referencia de LYN con transparencia.', cita: null }]);
  });

  it('descarta entradas incompletas, arquetipos inexistentes y recorta al máximo', () => {
    const muchas = Array.from({ length: MAX_OBJECIONES + 3 }, (_, i) => ({ objecion: `Objeción ${i}`, criterio: 'Criterio', cita: null }));
    const p = validarPropuesta(JSON.stringify({ resumen: '', objeciones: [...muchas, { objecion: '', criterio: 'x' }], arquetipos: [{ arquetipo: 'H', material: 'x' }], frases: [{ situacion: 'x' }] }), CITAS);
    expect(p.objeciones).toHaveLength(MAX_OBJECIONES);
    expect(p.arquetipos).toEqual([]);
    expect(p.frases).toEqual([]);
  });

  it('enmascara o descarta datos personales que se colaran en la propuesta', () => {
    const p = validarPropuesta(JSON.stringify(propuesta({ frases: [{ situacion: 'Contacto', frase: 'Llámame al 612 345 678 o escribe a ana@example.com' }] })), CITAS);
    const texto = JSON.stringify(p);
    expect(texto).not.toContain('612 345 678');
    expect(texto).not.toContain('ana@example.com');
  });

  it('una respuesta que no es JSON invalida la actualización', () => {
    expect(() => validarPropuesta('no es json', CITAS)).toThrow(PropuestaInvalida);
  });
});

describe('Entrenador · añadir al documento', () => {
  it('añade en las secciones 6, 11 y 18 sin borrar ni cambiar el texto de Jean', () => {
    const nuevo = aplicarPropuesta(DOCUMENTO_BASE, propuesta(), PERIODO);
    for (const linea of DOCUMENTO_BASE.split('\n').filter((l) => l.trim())) expect(nuevo).toContain(linea);
    const pos = (texto: string) => nuevo.indexOf(texto);
    // Cada bloque queda dentro de su sección: después de su título y antes del de la siguiente.
    expect(pos('ARQUETIPOS — CASOS REALES DE NETELIP')).toBeGreaterThan(pos('6. ARQUETIPOS'));
    expect(pos('ARQUETIPOS — CASOS REALES DE NETELIP')).toBeLessThan(pos('7. CONTEXTO REAL DE GRUPO LYN'));
    expect(pos('OBJECIONES — CASOS REALES DE NETELIP')).toBeGreaterThan(pos('11. BANCO DE OBJECIONES'));
    expect(pos('OBJECIONES — CASOS REALES DE NETELIP')).toBeLessThan(pos('12. DATOS MÍNIMOS ANTES DE AGENDAR'));
    expect(pos('FRASES — CASOS REALES DE NETELIP')).toBeGreaterThan(pos('18. FRASES DE REFERENCIA'));
    expect(pos('FRASES — CASOS REALES DE NETELIP')).toBeLessThan(pos('19. CONTROL DE CALIDAD'));
    expect(nuevo).toContain('Dicho por un cliente real: «Tengo un amigo aparejador que vino a dar un vistazo»');
    expect(nuevo).toContain('(llamadas del 01/11/2026 al 08/11/2026, 1 evaluadas)');
    expect(nuevo.split('\n')[3]).toBe('Actualizado con llamadas reales de Netelip hasta el 08/11/2026');
  });

  it('la siguiente actualización suma otro bloque y cambia la fecha de la cabecera, no la duplica', () => {
    const v1 = aplicarPropuesta(DOCUMENTO_BASE, propuesta(), PERIODO);
    const v2 = aplicarPropuesta(v1, propuesta({ arquetipos: [], frases: [] }), { desde: PERIODO.hasta, hasta: new Date('2026-11-15T18:00:00Z'), llamadas: 3 });
    expect(v2.match(/OBJECIONES — CASOS REALES DE NETELIP/g)).toHaveLength(2);
    expect(v2.match(/^Actualizado con llamadas reales de Netelip/gm)).toHaveLength(1);
    expect(v2).toContain('Actualizado con llamadas reales de Netelip hasta el 15/11/2026');
  });

  it('sin nada nuevo solo cambia la fecha de la cabecera', () => {
    const vacia = propuesta({ objeciones: [], arquetipos: [], frases: [] });
    expect(propuestaVacia(vacia)).toBe(true);
    const nuevo = aplicarPropuesta(DOCUMENTO_BASE, vacia, PERIODO);
    expect(nuevo.replace(/^Actualizado con llamadas reales.*\n/m, '')).toBe(DOCUMENTO_BASE);
  });

  it('un documento sin las secciones esperadas no se toca', () => {
    expect(() => aplicarPropuesta('Documento sin secciones', propuesta(), PERIODO)).toThrow(PropuestaInvalida);
  });

  it('el prompt lleva el documento y los casos, con el nombre legible de cada regla', () => {
    const prompt = promptUsuario('DOC', [LLAMADA]);
    expect(prompt).toContain('<<<\nDOC\n>>>');
    expect(prompt).toContain('Error crítico (REGLA CERO): «lo hablo con mi mujer y te envío un WhatsApp»');
    expect(prompt).toContain('Llamada 1 · closer_f2 · saliente · 15 min · nota 62 · NO APTO');
  });
});

describe('Entrenador · .docx', () => {
  it('reconoce títulos, secciones, subtítulos de casos reales y viñetas', () => {
    const bloques = bloquesDelDocumento(aplicarPropuesta(DOCUMENTO_BASE, propuesta(), PERIODO));
    expect(bloques[0]).toEqual({ tipo: 'titulo', texto: 'GRUPO LYN — ENTRENADOR DE LLAMADAS FASE 0' });
    expect(bloques).toContainEqual({ tipo: 'seccion', texto: '11. BANCO DE OBJECIONES Y CRITERIO CORRECTO' });
    expect(bloques.filter((b) => b.tipo === 'subtitulo')).toHaveLength(3);
    expect(bloques).toContainEqual({ tipo: 'vineta', texto: '«Lo hablo con mi mujer y te envío un WhatsApp».' });
  });

  it('genera un .docx válido (ZIP)', async () => {
    const buffer = await documentoDocx(DOCUMENTO_BASE);
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    expect(buffer.length).toBeGreaterThan(5000);
  });
});

describe('Entrenador · Google Drive', () => {
  const llamadas: Array<{ url: string; method: string }> = [];
  const respuesta = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetcher = (respuestas: Response[]) => (async (url: string | URL, init?: RequestInit) => {
    llamadas.push({ url: String(url), method: String(init?.method) });
    return respuestas.shift()!;
  }) as typeof fetch;

  it('saca el ID de la carpeta del enlace o del ID', () => {
    expect(idCarpetaDrive('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing')).toBe('1AbCdEfGhIjKlMnOp');
    expect(idCarpetaDrive('1AbCdEfGhIjKlMnOp')).toBe('1AbCdEfGhIjKlMnOp');
    expect(idCarpetaDrive('')).toBeNull();
    expect(idCarpetaDrive('no vale')).toBeNull();
  });

  it('la primera vez crea el archivo en la carpeta', async () => {
    llamadas.length = 0;
    const r = await publicarDocx({ token: 't', carpetaId: 'CARPETA', fileId: null, nombre: 'doc.docx', contenido: Buffer.from('x'),
      fetcher: fetcher([respuesta(200, { id: 'F1', webViewLink: 'https://drive/F1', parents: ['CARPETA'] })]) });
    expect(r).toEqual({ id: 'F1', url: 'https://drive/F1', enCarpeta: true });
    expect(llamadas).toEqual([expect.objectContaining({ method: 'POST', url: expect.stringContaining('uploadType=multipart') })]);
  });

  it('las siguientes sustituyen el mismo archivo, así el enlace no cambia', async () => {
    llamadas.length = 0;
    const r = await publicarDocx({ token: 't', carpetaId: 'CARPETA', fileId: 'F1', nombre: 'doc.docx', contenido: Buffer.from('x'),
      fetcher: fetcher([respuesta(200, { id: 'F1', webViewLink: 'https://drive/F1', parents: ['CARPETA'] })]) });
    expect(r.id).toBe('F1');
    expect(llamadas).toEqual([expect.objectContaining({ method: 'PATCH', url: expect.stringContaining('/files/F1?uploadType=media') })]);
  });

  it('si drive.file no deja usar la carpeta, lo crea en la raíz y lo indica', async () => {
    llamadas.length = 0;
    const r = await publicarDocx({ token: 't', carpetaId: 'CARPETA', fileId: null, nombre: 'doc.docx', contenido: Buffer.from('x'),
      fetcher: fetcher([respuesta(404, { error: { message: 'File not found: CARPETA' } }), respuesta(200, { id: 'F2', webViewLink: 'https://drive/F2', parents: ['root'] })]) });
    expect(r).toEqual({ id: 'F2', url: 'https://drive/F2', enCarpeta: false });
    expect(llamadas.map((l) => l.method)).toEqual(['POST', 'POST']);
  });

  it('un error de permisos no se oculta', async () => {
    await expect(publicarDocx({ token: 't', carpetaId: 'CARPETA', fileId: null, nombre: 'doc.docx', contenido: Buffer.from('x'),
      fetcher: fetcher([respuesta(403, { error: { message: 'Insufficient Permission' } })]) })).rejects.toThrow('crear el archivo: Insufficient Permission');
  });
});
