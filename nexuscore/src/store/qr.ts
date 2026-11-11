/**
 * QR-Code fuer die Einrichtung der Zwei-Faktor-Anmeldung - ohne Fremdpaket.
 *
 * Bewusst klein: Bytemodus, Fehlerkorrektur M, Versionen 1 bis 10 (bis 213 Bytes) - genug fuer eine
 * otpauth-Adresse. Aufbau nach ISO/IEC 18004 (Kodierung, Reed-Solomon ueber GF(256), Verschachtelung,
 * Funktionsmuster, Maskenauswahl). Die Tests lesen das Ergebnis mit einem echten Decoder (OpenCV) zurueck.
 */

// Fehlerkorrektur-Stufe M: Version -> [Korrekturbytes je Block, Anzahl Bloecke]
const ECC_M: Record<number, [number, number]> = {
  1: [10, 1],
  2: [16, 1],
  3: [26, 1],
  4: [18, 2],
  5: [24, 2],
  6: [16, 4],
  7: [18, 4],
  8: [22, 4],
  9: [22, 5],
  10: [26, 5],
};
const MAX_VERSION = 10;

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver: number): number {
  const [ecc, blocks] = ECC_M[ver]!;
  return Math.floor(rawDataModules(ver) / 8) - ecc * blocks;
}

// ------------------------------------------------------------ Reed-Solomon

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsGenerator(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i]! ^= gfMul(coef, factor);
    });
  }
  return result;
}

// ------------------------------------------------------------ Kodierung

function encodeData(bytes: Uint8Array, ver: number): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // Bytemodus
  put(bytes.length, ver >= 10 ? 16 : 8);
  for (const b of bytes) put(b, 8);
  const capacityBits = dataCodewords(ver) * 8;
  put(0, Math.min(4, capacityBits - bits.length)); // Abschluss
  while (bits.length % 8 !== 0) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]!;
    out.push(v);
  }
  for (let pad = 0xec; out.length < dataCodewords(ver); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function interleave(data: number[], ver: number): number[] {
  const [eccLen, numBlocks] = ECC_M[ver]!;
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsGenerator(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0); // Platzhalter, damit alle Bloecke gleich lang sind
    blocks.push([...dat, ...ecc]);
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]!);
    });
  }
  return result;
}

// ------------------------------------------------------------ Matrix

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  drawFunctionPatterns(): void {
    const { size, version } = this;
    for (let i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    const pos = alignmentPositions(version, size);
    const last = pos.length - 1;
    pos.forEach((px, i) => {
      pos.forEach((py, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        this.drawAlignment(px, py);
      });
    });
    this.drawFormat(0); // Platz belegen; wird nach der Maskenwahl neu gezeichnet
    this.drawVersion();
  }

  private drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFunction(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  private drawAlignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  drawFormat(mask: number): void {
    const { size } = this;
    const data = (0 << 3) | mask; // Stufe M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, bit(i));
    this.setFunction(8, size - 8, true); // das eine feste dunkle Modul
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  drawCodewords(data: number[]): void {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0; break;
          default: invert = ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0; break;
        }
        if (!this.isFunction[y]![x] && invert) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  /** Bewertung nach ISO 18004: lange Reihen, 2x2-Bloecke, suchmusteraehnliche Folgen, Hell-Dunkel-Verhaeltnis. */
  penalty(): number {
    const { size, modules } = this;
    let score = 0;
    const runs = (get: (a: number, b: number) => boolean) => {
      for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b < size; b++) {
          if (get(a, b) === get(a, b - 1)) {
            run++;
            if (run === 5) score += 3;
            else if (run > 5) score++;
          } else run = 1;
        }
      }
    };
    runs((y, x) => modules[y]![x]!);
    runs((x, y) => modules[y]![x]!);
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y]![x];
        if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) score += 3;
      }
    }
    // Suchmusterähnliche Folgen (dunkel-hell-dunkel-dunkel-dunkel-hell-dunkel mit vier hellen Modulen daneben)
    // sehen für einen Decoder wie ein drittes, viertes ... Suchmuster aus - 40 Punkte je Fund
    const pattern = [true, false, true, true, true, false, true];
    const finderLike = (get: (i: number) => boolean) => {
      const at = (i: number) => (i >= 0 && i < size ? get(i) : false);
      for (let i = 0; i + 7 <= size; i++) {
        if (!pattern.every((v, k) => get(i + k) === v)) continue;
        const lightBefore = [1, 2, 3, 4].every((d) => !at(i - d));
        const lightAfter = [0, 1, 2, 3].every((d) => !at(i + 7 + d));
        if (lightBefore || lightAfter) score += 40;
      }
    };
    for (let a = 0; a < size; a++) {
      finderLike((i) => modules[a]![i]!);
      finderLike((i) => modules[i]![a]!);
    }
    let dark = 0;
    for (const row of modules) for (const m of row) if (m) dark++;
    const total = size * size;
    score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
    return score;
  }
}

function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

export class QrTooLongError extends Error {
  constructor(length: number) {
    super(`Der Text ist mit ${length} Bytes zu lang für diesen QR-Code (höchstens ${Math.floor((dataCodewords(MAX_VERSION) * 8 - 20) / 8)}).`);
    this.name = 'QrTooLongError';
  }
}

/** Die Module des QR-Codes: `true` = dunkel, ohne Ruhezone. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    const headerBits = 4 + (v >= 10 ? 16 : 8);
    if (headerBits + bytes.length * 8 <= dataCodewords(v) * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) throw new QrTooLongError(bytes.length);

  const codewords = interleave(encodeData(bytes, version), version);
  const m = new Matrix(version);
  m.drawFunctionPatterns();
  m.drawCodewords(codewords);

  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    m.applyMask(mask);
    m.drawFormat(mask);
    const score = m.penalty();
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    m.applyMask(mask); // zurueck
  }
  m.applyMask(best);
  m.drawFormat(best);
  return m.modules;
}

/** Der QR-Code als SVG, mit Ruhezone von vier Modulen. */
export function qrSvg(text: string, border = 4): string {
  const modules = qrMatrix(text);
  const size = modules.length + border * 2;
  const parts: string[] = [];
  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + border},${y + border}h1v1h-1z`);
    });
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${parts.join('')}" fill="#000"/></svg>`;
}

/** Fuer `<img src>`: der QR-Code als data:-Adresse. */
export function qrDataUrl(text: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(qrSvg(text), 'utf8').toString('base64')}`;
}
