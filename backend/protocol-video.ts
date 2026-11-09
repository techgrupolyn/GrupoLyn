import type { ProtocolSection } from './protocol-answer-validation.ts';

export function parseProtocolVideoCaptions(vtt: string): ProtocolSection[] {
  if (!/^WEBVTT(?:\s|$)/u.test(vtt) || vtt.length > 500_000) throw new Error('Subtítulos VTT inválidos o demasiado grandes');
  const cues: Array<{ seconds: number; text: string }> = [];
  for (const block of vtt.replace(/\r/gu, '').split(/\n\s*\n/gu)) {
    const lines = block.split('\n');
    const timeIndex = lines.findIndex(line => /\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/u.test(line));
    if (timeIndex < 0) continue;
    const match = /^(\d{2}):(\d{2}):(\d{2})\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/u.exec(lines[timeIndex]);
    if (!match) continue;
    const text = lines.slice(timeIndex + 1).join(' ').replace(/<[^>]*>/gu, '').replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/\s+/gu, ' ').trim();
    if (!text) continue;
    cues.push({ seconds: Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]), text });
  }
  if (!cues.length) throw new Error('El video no tiene subtítulos con marcas de tiempo');
  const groups = new Map<number, string[]>();
  for (const cue of cues) {
    const start = Math.floor(cue.seconds / 30) * 30;
    const lines = groups.get(start) || [];
    if (lines.at(-1) !== cue.text) lines.push(cue.text);
    groups.set(start, lines);
  }
  return [...groups].map(([seconds, lines]) => ({
    ref: `video ${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
    text: lines.join(' '),
  }));
}
