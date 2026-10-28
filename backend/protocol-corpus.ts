import { createHash } from 'node:crypto';
import type { ProtocolDocument, ProtocolSection } from './protocol-answer-validation.ts';

export type ProtocolFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  revision: string;
  extractionVersion?: number;
  sections: ProtocolSection[];
  warnings: string[];
};

export type ProtocolCorpus = {
  id: string;
  createdAt: string;
  files: ProtocolFile[];
  documents: ProtocolDocument[];
  tokenEstimate: number;
};

export function protocolFileAllowed(name: string, parentId: string, protocolFolderId: string): boolean {
  return parentId === protocolFolderId && !/^_Obsoletos$/iu.test(name.trim()) && !/^Plantillas Quantifier$/iu.test(name.trim());
}

export function createProtocolCorpus(files: ProtocolFile[], maxTokens: number, now = new Date()): ProtocolCorpus {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('Límite de tokens inválido');
  const sorted = [...files].sort((left, right) => left.id.localeCompare(right.id));
  if (!sorted.length || sorted.some(file => !file.id || !file.revision || !file.sections.length || file.sections.some(section => !section.ref || !section.text.trim()))) throw new Error('Corpus incompleto');
  if (new Set(sorted.map(file => file.id)).size !== sorted.length) throw new Error('Archivo duplicado en el corpus');
  const tokenEstimate = Math.ceil(sorted.reduce((sum, file) => sum + file.sections.reduce((sectionSum, section) => sectionSum + section.text.length, 0), 0) / 3);
  if (tokenEstimate > maxTokens) throw new Error(`El corpus supera el límite de ${maxTokens} tokens`);
  const fingerprint = JSON.stringify(sorted.map(file => [file.id, file.revision, file.modifiedTime, file.extractionVersion, file.sections]));
  const id = createHash('sha256').update(fingerprint).digest('hex');
  return {
    id, createdAt: now.toISOString(),
    files: structuredClone(sorted),
    documents: sorted.map(file => ({ id: file.id, sections: structuredClone(file.sections) })),
    tokenEstimate,
  };
}

export function protocolCorpusPrompt(corpus: ProtocolCorpus): string {
  const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<corpus version="${corpus.id}" fecha="${corpus.createdAt}">\n${corpus.files.map(file => `<documento id="${escapeXml(file.id)}" titulo="${escapeXml(file.name)}" formato="${escapeXml(file.mimeType)}" modificado="${escapeXml(file.modifiedTime)}">\n${file.sections.map(section => `<seccion ref="${escapeXml(section.ref)}">${escapeXml(section.text)}</seccion>`).join('\n')}\n</documento>`).join('\n')}\n</corpus>`;
}
