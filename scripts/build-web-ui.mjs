import { cp, mkdir, readFile, rm } from 'node:fs/promises';

const sourceDirectory = 'src/remote-ui';
const outputDirectory = 'deploy/relay-server/public';
const requiredFiles = ['index.html', 'remote.css', 'remote.js', 'web-version.json'];

const version = JSON.parse(await readFile(`${sourceDirectory}/web-version.json`, 'utf8'));
if (!version.version || version.clientProtocol !== 1) {
  throw new Error('src/remote-ui/web-version.json is invalid');
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(sourceDirectory, outputDirectory, { recursive: true });

for (const file of requiredFiles) {
  await readFile(`${outputDirectory}/${file}`);
}

console.log(`GPTTool Web UI ${version.version} prepared in ${outputDirectory}`);
