export function beginClubSso({ host = window, clubOrigin, onError, fetcher = fetch, cryptoApi = crypto }) {
  const opener = host.opener;
  const state = new URLSearchParams(host.location.search).get('state');
  let stopped = false;
  let receiving = false;
  let interval;
  let timeout;
  const controller = new AbortController();
  const stop = () => {
    stopped = true;
    clearInterval(interval);
    clearTimeout(timeout);
    host.removeEventListener('message', receive);
    controller.abort();
  };
  const fail = (message) => {
    if (stopped) return;
    stop();
    onError(message);
  };
  const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const verifier = base64url(cryptoApi.getRandomValues(new Uint8Array(32)));
  async function receive(event) {
    if (stopped || receiving || event.origin !== clubOrigin || event.source !== opener || event.data?.state !== state) return;
    if (event.data.type === 'lyn-club-sso-error') { fail('No se pudo validar tu sesión. Vuelve a Club LYN e inténtalo de nuevo.'); return; }
    if (event.data.type !== 'lyn-club-sso-code' || typeof event.data.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(event.data.code)) return;
    receiving = true;
    clearInterval(interval);
    try {
      const response = await fetcher('/api/auth/club-sso/exchange', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: event.data.code, verifier }), signal: controller.signal,
      });
      const result = await response.json();
      if (stopped) return;
      if (!response.ok || !result.usuario?.id || !result.token) throw new Error(result.error || 'No se pudo iniciar sesión');
      host.localStorage.setItem('lyn_ceo_user', JSON.stringify(result.usuario));
      host.localStorage.setItem('ceo_token', result.token);
      opener.postMessage({ type: 'lyn-club-sso-complete', state }, clubOrigin);
      stop();
      host.opener = null;
      host.location.replace('/?view=meetings');
    } catch (error) {
      fail(error.message || 'No se pudo conectar con el gestor');
    }
  }
  try {
    const origin = new URL(clubOrigin);
    if (origin.origin !== clubOrigin || !['https:', 'http:'].includes(origin.protocol) ||
        (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) ||
        !opener || !/^[a-f0-9]{32}$/.test(state || '')) throw new Error();
  } catch {
    onError('Abre el gestor desde Club LYN. El acceso directo o la configuración no son válidos.');
    return stop;
  }
  host.addEventListener('message', receive);
  timeout = setTimeout(() => fail('El acceso ha caducado. Vuelve a abrir el gestor desde Club LYN.'), 90000);
  cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then((hash) => {
    if (stopped) return;
    const message = { type: 'lyn-club-sso-ready', state, challenge: base64url(new Uint8Array(hash)) };
    const notify = () => opener.postMessage(message, clubOrigin);
    notify();
    interval = setInterval(notify, 500);
  }).catch(() => fail('No se pudo preparar el acceso seguro'));
  return stop;
}
