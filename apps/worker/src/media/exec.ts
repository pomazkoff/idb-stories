import { spawn } from 'node:child_process';

export class ExecError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly timedOut: boolean,
  ) {
    super(message);
    this.name = 'ExecError';
  }
}

/**
 * Запуск ffmpeg/ffprobe: минимальное окружение, без stdin, жёсткий таймаут с SIGKILL,
 * ограничение объёма вывода.
 */
export function run(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; maxOutputBytes?: number },
): Promise<{ stdout: string; stderr: string }> {
  const max = opts.maxOutputBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill('SIGKILL');
      },
      Math.max(1, opts.timeoutMs),
    );
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ExecError(`${bin}: ${err.message}`, stderr, false));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new ExecError(`${bin}: превышено время`, stderr, true));
      else if (code !== 0) reject(new ExecError(`${bin}: код выхода ${code}`, stderr, false));
      else resolve({ stdout, stderr });
    });
  });
}
