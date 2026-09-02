import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

/** Numeric diagnostics only: never record task content, paths, or credentials. */
export function startRuntimeDiagnostics(directory: string, version: string): () => void {
  const file = path.join(directory, 'runtime-memory.jsonl');
  let writing = false;
  const sample = async (): Promise<void> => {
    if (writing) return;
    writing = true;
    try {
      await mkdir(directory, { recursive: true });
      if ((await stat(file).catch(() => undefined))?.size! > 1024 * 1024) {
        await rename(file, `${file}.previous`);
      }
      await appendFile(file, JSON.stringify({
        at: new Date().toISOString(), version, pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()), ...process.memoryUsage(),
      }) + '\n');
    } catch {
      // Diagnostic storage failures must not interrupt remote control.
    } finally { writing = false; }
  };
  void sample();
  const timer = setInterval(() => void sample(), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
