// .docx del documento del entrenador: el mismo texto, con títulos y viñetas reconocibles en Word y Drive.
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { bloquesDelDocumento } from './documento.ts';

export const NOMBRE_DOCX = 'Contexto_Unificado_Entrenador_Llamadas_Grupo_LYN.docx';
export const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function documentoDocx(documento: string): Promise<Buffer> {
  const children = bloquesDelDocumento(documento).map((b) => {
    if (b.tipo === 'titulo') return new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(b.texto)] });
    if (b.tipo === 'seccion') return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360 }, children: [new TextRun(b.texto)] });
    if (b.tipo === 'subtitulo') return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240 }, children: [new TextRun(b.texto)] });
    if (b.tipo === 'vineta') return new Paragraph({ bullet: { level: 0 }, children: [new TextRun(b.texto)] });
    if (b.tipo === 'tabla') return new Paragraph({ children: [new TextRun({ text: b.texto, font: 'Courier New', size: 18 })] });
    return new Paragraph({ spacing: { after: 80 }, children: [new TextRun(b.texto)] });
  });
  const doc = new Document({
    creator: 'Grupo LYN · Superagente', title: 'Entrenador de llamadas Fase 0 — Contexto unificado',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
