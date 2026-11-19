/**
 * Minimal QR Code matrix encoder (byte mode, ECC level M).
 *
 * Zero dependencies. Sized for Kindora pairing URLs (~70 bytes →
 * version 5). Not a full QR library — versions 1–10, ECC-M only.
 *
 * Algorithm follows ISO/IEC 18004 module placement + Reed-Solomon
 * over GF(256). Mask pattern is chosen by the standard penalty score.
 */

/** ECC level M — medium recovery, good for screen-to-camera pairing. */
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  // [total data codewords, ecc per block, num blocks] per version 1..10
  /* 1 */ [16, 10, 1],
  /* 2 */ [28, 16, 1],
  /* 3 */ [44, 26, 1],
  /* 4 */ [64, 18, 2],
  /* 5 */ [86, 24, 2],
  /* 6 */ [108, 16, 4],
  /* 7 */ [124, 18, 4],
  /* 8 */ [154, 22, 4],
  /* 9 */ [182, 22, 5],
  /*10 */ [216, 26, 5],
];

const ALIGNMENT_POSITIONS: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

export function encodeQrMatrix(text: string): boolean[][] {
  const data = new TextEncoder().encode(text);
  let version = 1;
  for (; version <= 10; version++) {
    const capacity = ECC_CODEWORDS_PER_BLOCK[version - 1]![0]!;
    // mode(4) + length(8 for v<10) + data + terminator ≈ data.length + 3
    if (data.length + 3 <= capacity) break;
  }
  if (version > 10) {
    throw new Error('QR payload too long for the built-in encoder (max ~200 bytes).');
  }

  const spec = ECC_CODEWORDS_PER_BLOCK[version - 1]!;
  const dataCodewords = spec[0]!;
  const eccPerBlock = spec[1]!;
  const numBlocks = spec[2]!;
  const size = 21 + (version - 1) * 4;

  // Build bit stream: mode byte (0100) + length + data + terminator + pad
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, data.length, version < 10 ? 8 : 16);
  for (const b of data) pushBits(bits, b, 8);
  pushBits(bits, 0, Math.min(4, dataCodewords * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | (bits[i + j] ?? 0);
    codewords.push(v);
  }
  const padBytes = [0xec, 0x11];
  let pad = 0;
  while (codewords.length < dataCodewords) {
    codewords.push(padBytes[pad % 2]!);
    pad++;
  }

  // Split into blocks, append ECC
  const blockDataLen = Math.floor(dataCodewords / numBlocks);
  const shortBlocks = numBlocks - (dataCodewords % numBlocks);
  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const len = blockDataLen + (b < shortBlocks ? 0 : 1);
    const block = codewords.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    eccBlocks.push(reedSolomon(block, eccPerBlock));
  }

  // Interleave
  const interleaved: number[] = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) interleaved.push(block[i]!);
    }
  }
  for (let i = 0; i < eccPerBlock; i++) {
    for (const block of eccBlocks) interleaved.push(block[i]!);
  }

  // Find best mask
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const matrix = buildMatrix(version, size, interleaved, mask);
    const score = penalty(matrix);
    if (score < bestScore) {
      bestScore = score;
      best = matrix;
    }
  }
  return best!;
}

function pushBits(bits: number[], value: number, len: number): void {
  for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function reedSolomon(data: number[], eccLen: number): number[] {
  const gen = rsGenerator(eccLen);
  const res = new Array<number>(eccLen).fill(0);
  for (const b of data) {
    const factor = b ^ res[0]!;
    res.shift();
    res.push(0);
    for (let i = 0; i < eccLen; i++) {
      res[i] = res[i]! ^ gfMul(gen[i]!, factor);
    }
  }
  return res;
}

function rsGenerator(n: number): number[] {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] = next[j]! ^ g[j]!;
      next[j + 1] = next[j + 1]! ^ gfMul(g[j]!, gfPow(2, i));
    }
    g = next;
  }
  return g.slice(1);
}

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function gfPow(a: number, p: number): number {
  let r = 1;
  for (let i = 0; i < p; i++) r = gfMul(r, a);
  return r;
}

function buildMatrix(
  version: number,
  size: number,
  data: number[],
  mask: number,
): boolean[][] {
  const m: (boolean | null)[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => null),
  );

  placeFinders(m);
  placeAlignments(m, version);
  placeTiming(m);
  // Dark module
  m[size - 8]![8] = true;
  // Reserve format / version modules (overwritten with final bits later)
  placeFormat(m, mask);
  if (version >= 7) placeVersion(m, version);

  // Zigzag data
  let bitIndex = 0;
  const totalBits = data.length * 8;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const x = col - c;
        if (m[row]![x] !== null) continue;
        let bit = false;
        if (bitIndex < totalBits) {
          const byte = data[bitIndex >> 3]!;
          bit = ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
        if (maskBit(mask, row, x)) bit = !bit;
        m[row]![x] = bit;
      }
    }
    upward = !upward;
  }

  placeFormat(m, mask);
  if (version >= 7) placeVersion(m, version);

  return m.map((row) => row.map((v) => Boolean(v)));
}

function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function placeFinders(m: (boolean | null)[][]): void {
  const size = m.length;
  const positions: [number, number][] = [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ];
  for (const [r0, c0] of positions) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const on =
          r >= 0 &&
          r <= 6 &&
          c >= 0 &&
          c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        m[rr]![cc] = on;
      }
    }
  }
}

function placeTiming(m: (boolean | null)[][]): void {
  const size = m.length;
  for (let i = 0; i < size; i++) {
    if (m[6]![i] === null) m[6]![i] = i % 2 === 0;
    if (m[i]![6] === null) m[i]![6] = i % 2 === 0;
  }
}

function placeAlignments(m: (boolean | null)[][], version: number): void {
  const size = m.length;
  const pos = ALIGNMENT_POSITIONS[version - 1]!;
  for (const r of pos) {
    for (const c of pos) {
      if (overlapsFinder(r, c, size)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          m[r + dr]![c + dc] = dist === 0 || dist === 2;
        }
      }
    }
  }
}

function overlapsFinder(r: number, c: number, size: number): boolean {
  if (r <= 8 && c <= 8) return true;
  if (r <= 8 && c >= size - 9) return true;
  if (r >= size - 9 && c <= 8) return true;
  return false;
}

function placeFormat(m: (boolean | null)[][], mask: number): void {
  // ECC-M = 00, mask in low 3 bits → format bits
  const eccMask = (0b00 << 3) | mask;
  const data = eccMask;
  let d = data << 10;
  const poly = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if ((d >>> i) & 1) d ^= poly << (i - 10);
  }
  const bits = (data << 10) | d;
  const format = bits ^ 0b101010000010010;
  const size = m.length;
  const coordsA: [number, number][] = [
    [8, 0],
    [8, 1],
    [8, 2],
    [8, 3],
    [8, 4],
    [8, 5],
    [8, 7],
    [8, 8],
    [7, 8],
    [5, 8],
    [4, 8],
    [3, 8],
    [2, 8],
    [1, 8],
    [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    const bit = ((format >>> i) & 1) === 1;
    const [r, c] = coordsA[i]!;
    m[r]![c] = bit;
  }
  // Mirror
  for (let i = 0; i < 8; i++) {
    m[size - 1 - i]![8] = ((format >>> i) & 1) === 1;
  }
  for (let i = 0; i < 7; i++) {
    m[8]![size - 7 + i] = ((format >>> (14 - i)) & 1) === 1;
  }
}

function placeVersion(m: (boolean | null)[][], version: number): void {
  let d = version << 12;
  const poly = 0b1111100100101;
  for (let i = 17; i >= 12; i--) {
    if ((d >>> i) & 1) d ^= poly << (i - 12);
  }
  const bits = (version << 12) | d;
  const size = m.length;
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) === 1;
    const r = Math.floor(i / 3);
    const c = size - 11 + (i % 3);
    m[r]![c] = bit;
    m[c]![r] = bit;
  }
}

function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  // N1: runs of 5+
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (m[r]![c] === m[r]![c - 1]) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (m[r]![c] === m[r - 1]![c]) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }
  // N2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r]![c];
      if (v === m[r]![c + 1] && v === m[r + 1]![c] && v === m[r + 1]![c + 1]) score += 3;
    }
  }
  // N4: balance
  let dark = 0;
  for (const row of m) for (const cell of row) if (cell) dark++;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}
