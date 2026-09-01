const RETRY_KEY = 'lyn:chunk-retry-after-deploy';

export function importWithChunkRecovery(loader, {
  session = window.sessionStorage,
  currentUrl = window.location.href,
  replace = (url) => window.location.replace(url),
  now = () => Date.now(),
} = {}) {
  return Promise.resolve()
    .then(loader)
    .then((module) => {
      session.removeItem(RETRY_KEY);
      return module;
    })
    .catch((error) => {
      const message = String(error?.message || error);
      if (!/dynamically imported module|chunkloaderror|loading chunk|importing a module script failed/i.test(message)) throw error;

      if (session.getItem(RETRY_KEY)) {
        session.removeItem(RETRY_KEY);
        throw error;
      }

      session.setItem(RETRY_KEY, '1');
      const url = new URL(currentUrl);
      url.searchParams.set('_chunk_retry', String(now()));
      replace(url.toString());
      return new Promise(() => {});
    });
}