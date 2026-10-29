import type { ProtocolFile } from './protocol-corpus.ts';

export type ProtocolVisionPage = { ref: string; image: string; textLayer: string; kind?: 'scanned' };

function tableCells(line: string): string[] {
  return line.split(/(?<!\\)\|/u).slice(1, -1);
}

export function protocolTableColumnCount(sectionText: string): number {
  const rows = sectionText.split('\n').filter(line => line.startsWith('| ')).map(tableCells);
  return rows.reduce((count, row) => Math.max(count, row.reduce((last, cell, index) => cell.trim() ? index + 1 : last, 0)), 0);
}

function words(value: string): Set<string> {
  return new Set(value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
}

export async function applyProtocolVision(
  sections: ProtocolFile['sections'],
  pages: ProtocolVisionPage[],
  transcribe: (image: Buffer, page: ProtocolVisionPage) => Promise<string>,
): Promise<{ sections: ProtocolFile['sections']; warnings: string[] }> {
  const replacements = new Map<string, string>();
  const warnings: string[] = [];
  const excluded = new Set<string>();
  for (const page of pages) {
    const source = sections.find(section => section.ref === page.ref);
    if (!source) continue;
    const markdown = (await transcribe(Buffer.from(page.image, 'base64'), page)).trim();
    const tableLines = markdown.split(/\r?\n/gu).filter(line => line.trim().startsWith('|'));
    const dataLines = tableLines.filter(line => !tableCells(line.trim()).every(cell => /^\s*:?-+:?\s*$/u.test(cell)));
    const sourceLines = source.text.split('\n').filter(line => line.startsWith('| '));
    const columnCounts = tableLines.map(line => tableCells(line.trim()).length);
    const sourceColumns = protocolTableColumnCount(source.text);
    const alignedColumns = columnCounts.length > 0 && sourceColumns >= 2 && tableLines.every((line, index) => line.trim().endsWith('|') && columnCounts[index] === sourceColumns);
    const alignedRows = dataLines.length === sourceLines.length && dataLines.every((line, index) => {
      const sourceLabelWords = words(tableCells(sourceLines[index])[0] || '');
      const visionLabelWords = words(tableCells(line.trim())[0] || '');
      return sourceLabelWords.size > 0 && [...sourceLabelWords].filter(word => visionLabelWords.has(word)).length / sourceLabelWords.size >= 0.8;
    });
    const layerWords = words(page.textLayer);
    const tableWords = words(markdown);
    const sourceWords = words(source.text.split('\n').filter(line => line.startsWith('| ')).join('\n'));
    const unknown = [...tableWords].filter(word => !layerWords.has(word));
    const coverage = sourceWords.size ? [...sourceWords].filter(word => tableWords.has(word)).length / sourceWords.size : 0;
    if (dataLines.length < 2 || !alignedColumns || !alignedRows || unknown.length || coverage < 0.8) {
      excluded.add(page.ref);
      warnings.push(`${page.ref}: transcripción visual no verificable (filas ${dataLines.length}, columnas alineadas ${alignedColumns}, orden de filas ${alignedRows}, palabras ajenas ${unknown.length}, cobertura ${Math.round(coverage * 100)} %); excluida`);
      continue;
    }
    replacements.set(page.ref, markdown);
  }
  return { sections: sections.filter(section => !excluded.has(section.ref)).map(section => ({ ...section, text: replacements.get(section.ref) || section.text })), warnings };
}
