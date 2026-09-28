import type { GeminiExecutionResult } from '../geminiService.ts';

export function evidencePayload(prompt: string) {
  return JSON.parse(prompt.split('DATOS_JSON:\n').at(-1)!);
}

export function evidenceResponse(prompt: string): GeminiExecutionResult {
  const data = evidencePayload(prompt);
  const output = data.analysis
    ? { approved: data.analysis.findings.map((_: unknown, index: number) => index), rejected: [], missing: [] }
    : { findings: [], informational: [[data.primary[0].ref, data.primary.at(-1).ref]] };
  return { text: JSON.stringify(output), provider: 'gemini', model: 'stub', fallback: false };
}
