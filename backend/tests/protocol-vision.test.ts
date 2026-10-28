import { describe, expect, it, vi } from 'vitest';
import { applyProtocolVision, protocolTableColumnCount } from '../protocol-vision.ts';
import { transcribeProtocolTable } from '../protocol-gemini.ts';

const section = { ref: 'página 2', text: '| Fase | PMC |\n| viernes | 30 min |' };
const page = { ref: 'página 2', image: Buffer.from('imagen').toString('base64'), textLayer: 'Fase PMC viernes 30 min' };

describe('transcripción visual de tablas PDF', () => {
  it('ignora columnas geométricas vacías al calcular el ancho visual', () => {
    expect(protocolTableColumnCount('| Fase | PMC |  |\n| viernes | 30 min |  |')).toBe(2);
    expect(protocolTableColumnCount('| Fase \\| etapa | PMC |')).toBe(2);
  });
  it('reemplaza la tabla cuando la visión coincide con la capa de texto', async () => {
    const result = await applyProtocolVision([section], [page], async () => '| Fase | PMC |\n| viernes | 30 min |');
    expect(result.sections).toEqual([section]);
    expect(result.warnings).toEqual([]);
  });

  it('excluye páginas con palabras inventadas o cobertura incompleta', async () => {
    const unknown = await applyProtocolVision([section], [page], async () => '| Fase | PMC |\n| viernes | mañana |');
    expect(unknown.sections).toEqual([]);
    expect(unknown.warnings).toHaveLength(1);
    const incomplete = await applyProtocolVision([section], [page], async () => '| Fase |\n| viernes |');
    expect(incomplete.sections).toEqual([]);
  });

  it('excluye tablas con filas desalineadas aunque sus palabras sean correctas', async () => {
    const ragged = await applyProtocolVision([section], [page], async () => '| Fase | PMC |\n| viernes | 30 min |\n| viernes |');
    expect(ragged.sections).toEqual([]);
    expect(ragged.warnings[0]).toContain('columnas alineadas false');
    const wrongWidth = await applyProtocolVision([section], [page], async () => '| Fase | PMC | viernes |\n| 30 | min | viernes |');
    expect(wrongWidth.sections).toEqual([]);
  });

  it('rechaza filas intercambiadas aunque conserve todas las columnas y palabras', async () => {
    const source = { ref: 'página 3', text: '| Fase | PMC |\n| 1 · Diseño | Revisar |\n| 2 · Obra | Aprobar |' };
    const image = { ref: 'página 3', image: page.image, textLayer: 'Fase PMC 1 Diseño Revisar 2 Obra Aprobar' };
    const swapped = await applyProtocolVision([source], [image], async () => '| Fase | PMC |\n| 2 - Obra | Aprobar |\n| 1 - Diseño | Revisar |');
    expect(swapped.sections).toEqual([]);
    expect(swapped.warnings[0]).toContain('orden de filas false');
  });

  it('no sustituye el PDF por una transcripción geométrica si cae el modelo', async () => {
    await expect(applyProtocolVision([section], [page], async () => { throw new Error('Modelo de visión no disponible'); })).rejects.toThrow('Modelo de visión no disponible');
  });

  it('envía la imagen al modelo sin almacenarla en el proveedor', async () => {
    const fetcher = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => Response.json({ output_text: JSON.stringify({ markdown: section.text }) }));
    const markdown = await transcribeProtocolTable(Buffer.from('imagen'), { apiKey: 'test-only', expectedColumns: 2, fetcher });
    expect(markdown).toBe(section.text);
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.store).toBe(false);
    expect(body.input[0].text).toContain('exactamente 2 celdas');
    expect(body.input[1]).toEqual({ type: 'image', data: Buffer.from('imagen').toString('base64'), mime_type: 'image/jpeg' });
  });

  it('exige celdas completas en el reintento estructurado', async () => {
    const fetcher = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => Response.json({ output_text: JSON.stringify({ rows: [{ c1: 'Fase', c2: 'PMC' }, { c1: 'viernes', c2: '30\nmin' }] }) }));
    const markdown = await transcribeProtocolTable(Buffer.from('imagen'), { apiKey: 'test-only', expectedColumns: 2, structuredRows: true, fetcher });
    expect(markdown).toBe(section.text);
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.response_format.schema.properties.rows.items.required).toEqual(['c1', 'c2']);
  });
});
