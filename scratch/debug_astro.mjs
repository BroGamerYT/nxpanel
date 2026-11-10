import { sql } from './dist/db/index.js';
import { prepareServer, provisionServer } from './dist/servers/create.js';

const [egg] = await sql`SELECT id FROM eggs WHERE name = 'Astroneer'`;
const [node] = await sql`SELECT id FROM nodes LIMIT 1`;
const [user] = await sql`SELECT id FROM users LIMIT 1`;
console.log('Creating server...');
const s = await prepareServer({
  name: 'Debug-Astroneer',
  eggId: egg.id,
  nodeId: node.id,
  ownerId: user.id,
  ramMb: 8192,
  diskMb: 25600,
  cpuPercent: 400,
  variables: { XVFB: '1' },
  autoRestart: false
});
console.log('Server prepared:', s.id, s.short_id);
await provisionServer(s.id, { actorId: user.id });
console.log('Provisioned! ShortId:', s.short_id);
process.exit(0);
