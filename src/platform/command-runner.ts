import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (executable: string, args: readonly string[]) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (executable, args) => {
  const result = await execFileAsync(executable, [...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};
