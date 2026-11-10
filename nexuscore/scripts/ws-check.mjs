/**
 * Prueft den WebSocket-Stream von NexusCore.
 *
 * Aufruf: node scripts/ws-check.mjs <url> [timeoutMs]
 * Beendet sich mit 0, wenn mindestens eine Nachricht empfangen wurde.
 */
import WebSocket from 'ws';

const url = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? 10000);

if (!url) {
  console.error('Aufruf: node scripts/ws-check.mjs <url> [timeoutMs]');
  process.exit(2);
}

let count = 0;
const timer = setTimeout(() => {
  console.error(`TIMEOUT nach ${timeoutMs} ms - ${count} Nachricht(en) empfangen.`);
  process.exit(1);
}, timeoutMs);

const socket = new WebSocket(url);

socket.on('open', () => {
  console.log(`VERBUNDEN zu ${url.replace(/token=[^&]+/, 'token=***')}`);
});

socket.on('message', (data) => {
  count += 1;
  const text = data.toString();
  if (count <= 3) {
    console.log(`NACHRICHT ${count}: ${text.slice(0, 200)}`);
  }
  if (count >= 1) {
    clearTimeout(timer);
    console.log(`OK - ${count} Nachricht(en) empfangen.`);
    socket.close();
    process.exit(0);
  }
});

socket.on('error', (err) => {
  clearTimeout(timer);
  console.error(`FEHLER: ${err.message}`);
  process.exit(1);
});
