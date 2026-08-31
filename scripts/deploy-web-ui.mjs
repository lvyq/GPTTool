import { spawn } from 'node:child_process';
import './build-web-ui.mjs';

const host = requiredEnv('GPTTOOL_WEB_DEPLOY_HOST');
// Keep the default aligned with the production systemd service.  The former
// /opt/gpttool-relay path was not served by nginx, so a successful deployment
// could silently leave the public Web UI on an old build.
const destination = process.env.GPTTOOL_WEB_DEPLOY_DIR || '/opt/astergate-relay/public/';

await run('ssh', [host, `mkdir -p ${shellQuote(destination)} && chown astergate:astergate ${shellQuote(destination)}`]);
await run('rsync', ['-az', '--delete', 'deploy/relay-server/public/', `${host}:${destination}`]);
await run('ssh', [
  host,
  `chown -R astergate:astergate ${shellQuote(destination)}`
    + ` && test -f ${shellQuote(`${destination}index.html`)}`
    + ` && test -f ${shellQuote(`${destination}web-version.json`)}`,
]);

console.log(`GPTTool Web UI deployed to ${host}:${destination}`);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with code ${code}`)));
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
