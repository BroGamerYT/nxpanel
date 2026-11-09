import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL);

async function run() {
  const [a3] = await sql`SELECT install_script FROM eggs WHERE name = 'Arma 3'`;
  console.log('Arma 3 install_script:\n', a3?.install_script);
  await sql.end();
}
run().catch(console.error);
