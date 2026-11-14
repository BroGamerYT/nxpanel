// Schnuert das Standalone-Bundle fuer die nexuscore.exe (Node SEA).
// Per API statt per Kommandozeile: unter PowerShell 7 und ueber esbuild.cmd gehen die verschachtelten Anfuehrungszeichen der
// --define-Werte verloren oder werden falsch gelesen - dann fehlt das Bundle und damit die ganze Exe.
import { build } from 'esbuild';
import { existsSync, statSync } from 'node:fs';

const out = 'dist/bundle.cjs';
await build({
  entryPoints: ['dist/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  outfile: out,
  format: 'cjs',
  define: {
    'process.env.NEXUSCORE_STANDALONE': '"1"',
    'import.meta.url': '__IMPORT_META_URL',
  },
  inject: ['scripts/sea-shim.js'],
  // Optionale native Module (ssh2: sshcrypto.node, cpu-features): wo sie gebaut wurden (z. B. auf dem CI-Rechner mit Visual Studio), kann esbuild
  // sie nicht buendeln. Extern lassen: das Programm sucht sie zur Laufzeit in try/catch und faellt auf reines JavaScript zurueck.
  external: ['*.node'],
  logLevel: 'info',
});
if (!existsSync(out) || statSync(out).size < 100_000) {
  console.error(`${out} fehlt oder ist zu klein`);
  process.exit(1);
}
console.log(`${out}: ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB`);
