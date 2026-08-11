import { AppServerCodexService } from '../codex/app-server-service.ts';
import { CodexService, type CodexServiceOptions } from '../codex/codex-service.ts';

export type ServiceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
export type CodexConnectionMode = 'hybrid' | 'app-server';
export type CodexRuntime = CodexService | AppServerCodexService;
export interface ApplicationCodexOptions extends CodexServiceOptions { connectionMode?: CodexConnectionMode }

/** Owns exactly one Codex runtime. Network proxy is intentionally not part of GPTTool. */
export class ApplicationOrchestrator {
  codexState: ServiceState = 'stopped';
  #codex?: CodexRuntime;

  constructor(private codexOptions: ApplicationCodexOptions) {}

  get codex(): CodexRuntime {
    if (!this.#codex || this.codexState !== 'running') throw new Error('Codex service is not running');
    return this.#codex;
  }

  configureCodex(options: ApplicationCodexOptions): void {
    if (this.codexState === 'running' || this.codexState === 'starting') throw new Error('Cannot reconfigure a running Codex service');
    this.codexOptions = options;
    this.#codex = undefined;
  }

  async startCodex(): Promise<void> {
    if (this.codexState === 'running' || this.codexState === 'starting') return;
    this.codexState = 'starting';
    const { connectionMode = 'hybrid', ...options } = this.codexOptions;
    this.#codex = connectionMode === 'app-server'
      ? new AppServerCodexService(options)
      : new CodexService(options);
    try {
      await this.#codex.start();
      this.codexState = 'running';
    } catch (error) {
      await this.#codex.stop().catch(() => undefined);
      this.#codex = undefined;
      this.codexState = 'failed';
      throw error;
    }
  }

  async stopCodex(): Promise<void> {
    if (this.codexState === 'stopped' || this.codexState === 'stopping') return;
    this.codexState = 'stopping';
    try {
      await this.#codex?.stop();
      this.#codex = undefined;
      this.codexState = 'stopped';
    } catch (error) {
      this.codexState = 'failed';
      throw error;
    }
  }

  async stopAll(): Promise<void> { await this.stopCodex().catch(() => undefined); }
}
