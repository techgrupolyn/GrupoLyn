import type { GeminiExecutionResult } from '../geminiService.ts';

export function evidencePayload(prompt: string) {
  return JSON.parse(prompt.split('DATOS_JSON:\n').at(-1)!);
}

export function evidenceResponse(prompt: string): GeminiExecutionResult {
  const data = evidencePayload(prompt);
  const output = data.sources
    ? data.draft ? { approved: true, issues: [], checks: { entities: true, actors: true, quantities: true, chronology: true, coverage: true } } : {
      entries: (data.mode === 'overview' ? data.sources.slice(0, 5) : data.sources).map((source: { id: string; subject?: string; group?: string; text: string }) => ({
        subject: source.subject || source.group || 'Tema QA', section: 'Pendientes', text: source.text.slice(0, 1800), sources: [source.id],
      })), excluded: [],
    }
    : data.analysis
    ? { approved: data.analysis.findings.map((_: unknown, index: number) => index), rejected: [], missing: [] }
    : { findings: [], informational: [[data.primary[0].ref, data.primary.at(-1).ref]] };
  return { text: JSON.stringify(output), provider: 'gemini', model: 'stub', fallback: false };
}
