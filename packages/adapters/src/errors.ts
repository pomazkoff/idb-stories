/** Внешняя система недоступна (таймаут, 5xx). Вызывающий код деградирует, а не падает. */
export class AdapterUnavailableError extends Error {
  constructor(
    readonly adapter: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${adapter}] ${message}`, options);
    this.name = 'AdapterUnavailableError';
  }
}

/** Выполняет вызов адаптера с таймаутом; любой сбой превращается в AdapterUnavailableError. */
export async function withTimeout<T>(
  adapter: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (err instanceof AdapterUnavailableError) throw err;
    const reason = controller.signal.aborted ? `таймаут ${timeoutMs} мс` : 'ошибка вызова';
    throw new AdapterUnavailableError(adapter, reason, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}
