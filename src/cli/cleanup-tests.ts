import 'dotenv/config';
import { sql, closeDatabase, waitForDatabase } from '../db/index.js';
import { deleteServer } from '../servers/create.js';

async function main() {
  await waitForDatabase();
  const servers = await sql<{ id: string; name: string }[]>`SELECT id, name FROM servers WHERE name LIKE 'Test-%'`;
  console.log(`Found ${servers.length} test servers to clean up.`);
  for (const s of servers) {
    console.log(`Deleting ${s.name} (${s.id})...`);
    try {
      await deleteServer(s.id);
    } catch (err) {
      console.warn(`Error deleting ${s.id}:`, err);
    }
  }
  console.log('Cleanup finished.');
  await closeDatabase();
}

main().catch(console.error);
