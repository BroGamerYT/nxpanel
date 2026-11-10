import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL);

async function run() {
  const vars = await sql`
    SELECT e.name, ev.env_variable, ev.default_value, ev.rules
    FROM egg_variables ev
    JOIN eggs e ON e.id = ev.egg_id
    WHERE e.name ILIKE '%arma%'
    ORDER BY e.name, ev.env_variable
  `;
  console.log(JSON.stringify(vars, null, 2));

  const reforgerEgg = await sql`SELECT id, name, config_files, startup FROM eggs WHERE name = 'Arma Reforger'`;
  console.log('Arma Reforger config_files:', JSON.stringify(reforgerEgg[0]?.config_files, null, 2));

  const astroneerEgg = await sql`SELECT id, name, config_files, startup, ready_check FROM eggs WHERE name = 'Astroneer'`;
  console.log('Astroneer Egg:', JSON.stringify(astroneerEgg[0], null, 2));

  await sql.end();
}
run().catch(console.error);
