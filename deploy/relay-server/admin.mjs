import { createStorage } from './storage.mjs';

const [command, ...args] = process.argv.slice(2);
const { store } = await createStorage();

if (command === 'create-user') {
  const [username, argumentPassword] = args;
  const password = argumentPassword || process.env.ASTERGATE_ADMIN_PASSWORD;
  if (!username || !password) throw new Error('Usage: admin.mjs create-user <username> <password>');
  console.log(JSON.stringify(await store.createUser(username, password)));
} else if (command === 'reset-password') {
  const [username, argumentPassword] = args;
  const password = argumentPassword || process.env.ASTERGATE_ADMIN_PASSWORD;
  if (!username || !password) throw new Error('Usage: admin.mjs reset-password <username> <password>');
  console.log(JSON.stringify(await store.resetPassword(username, password)));
} else if (command === 'import-device') {
  const [userId, deviceId, name, secret] = args;
  if (!userId || !deviceId || !name || !secret) throw new Error('Usage: admin.mjs import-device <userId> <deviceId> <name> <secret>');
  console.log(JSON.stringify(await store.importDevice(userId, { deviceId, name, secret })));
} else {
  throw new Error('Supported commands: create-user, reset-password, import-device');
}
