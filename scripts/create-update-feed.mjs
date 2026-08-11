import { createHash, sign } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const releaseNotes = JSON.parse(await readFile('release-notes.json', 'utf8'));
const version = String(packageJson.version);
const updateBaseUrl = requiredUrl(process.env.GPTTOOL_UPDATE_BASE_URL);
if (releaseNotes.version !== version || !Array.isArray(releaseNotes.notes)) {
  throw new Error('release-notes.json 必须与 package.json 版本一致');
}

const signingKeyPath = process.env.GPTTOOL_UPDATE_SIGNING_KEY
  || path.join(os.homedir(), '.config', 'gpttool-release', 'update-signing-ed25519.pem');
const signingKey = await readFile(signingKeyPath, 'utf8');
const sourceArtifacts = {
  darwin: path.resolve(`release/GPTTool-${version}-universal.dmg`),
  win32: path.resolve(`release/GPTTool-${version}-x64.exe`),
};
const updateDirectory = path.resolve('deploy/website/updates');
await mkdir(updateDirectory, { recursive: true });

const artifacts = {};
for (const [platform, sourcePath] of Object.entries(sourceArtifacts)) {
  const extension = platform === 'darwin' ? 'dmg' : 'exe';
  const fileName = `GPTTool-${version}-${platform === 'darwin' ? 'universal' : 'x64'}.${extension}`;
  const destination = path.join(updateDirectory, fileName);
  await copyFile(sourcePath, destination);
  const info = await stat(destination);
  artifacts[platform] = {
    url: new URL(fileName, updateBaseUrl).href,
    sha256: await sha256(destination),
    size: info.size,
  };
}

const manifest = {
  schema: 1,
  version,
  publishedAt: new Date().toISOString(),
  notes: releaseNotes.notes.map(String),
  artifacts,
};
const payload = Buffer.from(JSON.stringify(manifest), 'utf8');
const envelope = {
  payload: payload.toString('base64'),
  signature: sign(null, payload, signingKey).toString('base64'),
};
await writeFile(path.join(updateDirectory, 'latest.json'), `${JSON.stringify(envelope, null, 2)}\n`);
console.log(`GPTTool ${version} update feed created in ${updateDirectory}`);

async function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

function requiredUrl(value) {
  if (!value) throw new Error('请设置 GPTTOOL_UPDATE_BASE_URL（例如 https://updates.example.com/）');
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('更新地址必须使用 HTTPS');
  return url;
}
