import type { ReactNode } from 'react';

/** Minecraft-Farbcodes (§0-§f) in den Farben, die der Client zeigt. */
export const MC_COLORS: Array<{ code: string; hex: string; name: string }> = [
  { code: '0', hex: '#000000', name: 'black' }, { code: '1', hex: '#0000AA', name: 'dark_blue' },
  { code: '2', hex: '#00AA00', name: 'dark_green' }, { code: '3', hex: '#00AAAA', name: 'dark_aqua' },
  { code: '4', hex: '#AA0000', name: 'dark_red' }, { code: '5', hex: '#AA00AA', name: 'dark_purple' },
  { code: '6', hex: '#FFAA00', name: 'gold' }, { code: '7', hex: '#AAAAAA', name: 'gray' },
  { code: '8', hex: '#555555', name: 'dark_gray' }, { code: '9', hex: '#5555FF', name: 'blue' },
  { code: 'a', hex: '#55FF55', name: 'green' }, { code: 'b', hex: '#55FFFF', name: 'aqua' },
  { code: 'c', hex: '#FF5555', name: 'red' }, { code: 'd', hex: '#FF55FF', name: 'light_purple' },
  { code: 'e', hex: '#FFFF55', name: 'yellow' }, { code: 'f', hex: '#FFFFFF', name: 'white' },
];
export const MC_FORMATS = [
  { code: 'l', key: 'bold' }, { code: 'o', key: 'italic' }, { code: 'n', key: 'underline' },
  { code: 'm', key: 'strike' }, { code: 'k', key: 'magic' }, { code: 'r', key: 'reset' },
] as const;

/** §-Text so darstellen, wie er in der Minecraft-Serverliste aussieht. */
export function McText({ text, base = '#AAAAAA' }: { text: string; base?: string }) {
  const out: ReactNode[] = [];
  let color = base, bold = false, italic = false, under = false, strike = false, magic = false;
  const parts = text.split(/(§[0-9a-fk-or])/i);
  parts.forEach((p, i) => {
    const m = /^§([0-9a-fk-or])$/i.exec(p);
    if (m) {
      const c = m[1]!.toLowerCase();
      const col = MC_COLORS.find((x) => x.code === c);
      if (col) { color = col.hex; bold = italic = under = strike = magic = false; }
      else if (c === 'l') bold = true; else if (c === 'o') italic = true; else if (c === 'n') under = true;
      else if (c === 'm') strike = true; else if (c === 'k') magic = true;
      else if (c === 'r') { color = base; bold = italic = under = strike = magic = false; }
      return;
    }
    if (!p) return;
    out.push(
      <span key={i} style={{ color, fontWeight: bold ? 700 : undefined, fontStyle: italic ? 'italic' : undefined,
        textDecoration: [under && 'underline', strike && 'line-through'].filter(Boolean).join(' ') || undefined }}
        className={magic ? 'blur-[2px]' : undefined}>{p}</span>,
    );
  });
  return <>{out}</>;
}

/** MOTD aus der Variablen: Zeilen sind mit "\n" (Backslash-n, wie in server.properties) getrennt. */
export function splitMotd(v: string): [string, string] {
  const [a = '', b = ''] = v.replace(/\r/g, '').split(/\\n|\n/);
  return [a, b];
}
export const joinMotd = (a: string, b: string) => (b ? `${a}\\n${b}` : a);
export const stripCodes = (s: string) => s.replace(/§[0-9a-fk-or]/gi, '');
