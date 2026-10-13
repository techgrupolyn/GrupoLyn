export async function requestWithDeadline<Result>(operation: (signal: AbortSignal) => Promise<Result>, timeoutMs: number): Promise<Result> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('La petición externa agotó su tiempo de espera.');
      error.name = 'TimeoutError';
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
