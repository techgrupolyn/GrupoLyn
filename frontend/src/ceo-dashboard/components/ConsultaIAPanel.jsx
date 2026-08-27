import { useState } from 'react';
import api from '../api';

export default function ConsultaIAPanel() {
  const [pregunta, setPregunta] = useState('');
  const [respuesta, setRespuesta] = useState('');
  const [fuentes, setFuentes] = useState(null);
  const [ia, setIa] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  const [hasSent, setHasSent] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const texto = pregunta.trim();
    if (!texto || cargando) return;

    setHasSent(true);
    setCargando(true);
    setError('');
    setRespuesta('');
    setFuentes(null);
    setIa(null);
    console.log('[AI] Consulta:', texto);
    try {
      const data = await api.askAI(texto);
      setFuentes(data?.fuentes || null);
      setIa(data?.ia || null);
      setRespuesta(data?.respuesta || 'La IA no generó una respuesta.');
    } catch (err) {
      setError(err.message);
    } finally {
      setCargando(false);
    }
  };

  return (
    <section id="ai" className="ceo-page ceo-ai-panel p-4 sm:p-6 xl:p-8">
      <div className="border-b border-[#2E2E2E] pb-5">
        <div className="flex items-start justify-between gap-6">
          <div className="flex-1">
            <h3 className="font-display text-2xl font-medium text-[#F2F2F2] tracking-wide">Consultas a la IA</h3>
            <p className="mt-2 text-xs text-[#737373] leading-relaxed">
              Interactuá con Gemini sobre la base de datos de WhatsApp. Podés pedir resúmenes, tendencias o análisis específicos.
            </p>
          </div>
          {hasSent && (
            <span className="mt-1 shrink-0 rounded-full border border-[#2E2E2E] bg-[#0D0D0D] px-4 py-1.5 text-[10px] font-medium uppercase tracking-widest text-[#737373]">
              Asistente activo
            </span>
          )}
        </div>
      </div>

      <div className="ceo-ai-grid grid gap-5 pt-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-6">
          <div className="relative">
            <textarea
              value={pregunta}
              onChange={(e) => setPregunta(e.target.value)}
              placeholder="Consultá métricas, resúmenes o temas recurrentes..."
              rows={4}
              className="h-40 w-full resize-none ceo-surface rounded-md border border-[#2E2E2E] bg-[#0D0D0D] px-6 py-5 pr-14 text-sm text-[#F2F2F2] outline-none placeholder:text-[#BFBFBF] transition-colors duration-200 focus:border-[#F2F2F2]/30"
            />
            <div className="absolute bottom-5 right-5 flex items-center gap-2.5 text-[10px] font-medium uppercase tracking-widest text-[#737373]" aria-hidden="true">
              <span className="size-1 rounded-full bg-[#BFBFBF]" />
              {pregunta.length}/600
            </div>
          </div>

          <button
            type="submit"
            disabled={!pregunta.trim() || cargando}
            onClick={handleSubmit}
            className="flex w-full items-center justify-center gap-2.5 ceo-button-primary rounded-md bg-[#BFBFBF] px-6 py-4 text-xs font-semibold uppercase tracking-widest text-black transition-all duration-200 hover:bg-[#d4d4d4] disabled:cursor-not-allowed disabled:opacity-40 active:scale-[0.98]"
          >
            {cargando ? (
              <>
                <span className="inline-block h-3 w-3 animate-spin rounded-full border border-black/30 border-t-black" />
                Consultando…
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
                Enviar consulta
              </>
            )}
          </button>

          {error && (
            <div className="flex items-start gap-3 ceo-surface rounded-md border border-[#2E2E2E] bg-[#0D0D0D] p-5 text-xs text-[#737373]">
              <span className="mt-px inline-block size-1.5 shrink-0 rounded-full bg-[#BFBFBF]" />
              <span>{error}</span>
            </div>
          )}

          {respuesta && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-[0.3em] text-[#737373]">Respuesta de Gemini</p>
                <span className="rounded-full border border-[#2E2E2E] bg-[#141414] px-3 py-1 text-[10px] font-medium uppercase tracking-widest text-[#737373]">
                  {ia?.fallback ? 'Fallback local' : (ia?.modelo || 'Gemini')}
                </span>
              </div>
              <div className="whitespace-pre-wrap ceo-surface rounded-md border border-[#2E2E2E] bg-[#0D0D0D] p-6 text-sm leading-relaxed text-[#F2F2F2]">
                {respuesta}
              </div>
              {fuentes && (
                <p className="text-xs text-[#737373]">
                  Contexto: {fuentes.mensajes || 0} mensajes, {fuentes.resumenes || 0} resÃºmenes, {fuentes.respuestas || 0} respuestas y {fuentes.clasificaciones || 0} clasificaciones de los Ãºltimos {fuentes.periodo_dias || 0} dÃ­as.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="ceo-surface rounded-md border border-[#2E2E2E] bg-[#0D0D0D] p-6">
            <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Ejemplos</p>
            <ul className="mt-4 space-y-3 text-xs text-[#737373]">
              {['Resumen semanal de lo acontecido.', '¿Qué temas se hablaron más esta semana?', '¿Cuántos mensajes hay por día?'].map((ejemplo, index) => (
                <li key={index}>
                  <button
                    type="button"
                    onClick={() => setPregunta(ejemplo)}
                    className="w-full ceo-card rounded-md border border-[#2E2E2E] bg-[#141414] p-3 text-left transition-all duration-200 hover:border-[#F2F2F2]/20 hover:text-[#F2F2F2]"
                  >
                    {ejemplo}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="ceo-surface rounded-md border border-[#2E2E2E] bg-[#0D0D0D] p-6">
            <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Contexto</p>
            <ul className="mt-4 space-y-3 text-xs text-[#737373]">
              <li className="flex items-start gap-3">
                <span className="mt-px inline-block size-1 shrink-0 rounded-full bg-[#BFBFBF]" />
                <span>Se usa contexto real de mensajes guardados.</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-px inline-block size-1 shrink-0 rounded-full bg-[#BFBFBF]" />
                <span>Las respuestas son generadas por IA.</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-px inline-block size-1 shrink-0 rounded-full bg-[#BFBFBF]" />
                <span>Verificá la información antes de usarla.</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
