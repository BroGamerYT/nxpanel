// Wird beim Bauen der nexuscore.exe (Node SEA) in das Bundle eingefuegt.
// Im gebuendelten CommonJS-Code gibt es kein `import.meta.url`; der Bau ersetzt es durch diesen Wert:
// den Ort der nexuscore.exe. Damit liegen web, eggs und docs "neben dem Programm", wie der Core sie sucht.
import { pathToFileURL } from 'node:url';

export const __IMPORT_META_URL = pathToFileURL(process.execPath).href;
