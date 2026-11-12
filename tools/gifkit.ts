/**
 * gifkit — dependency-free pixel canvas + 5x7 bitmap font + GIF encoding.
 * Everything is drawn into a raw RGBA buffer; gifenc encodes it.
 * Runs anywhere Node runs (including Android/Termux) — no native modules.
 */
import gifencPkg from "gifenc";
import { writeFileSync } from "node:fs";

// gifenc is CJS; pull the encoder trio off its default export
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { GIFEncoder, quantize, applyPalette }: any = gifencPkg as any;

export type RGBA = [number, number, number, number];

const hex = (n: number) => n.toString(16).padStart(2, "0");
export const rgb = (hexColor: string, alpha = 255): RGBA => {
  const h = hexColor.replace("#", "");
  const v = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, alpha];
};

/* ───────────────────────── canvas ───────────────────────── */

export class Canvas {
  readonly width: number;
  readonly height: number;
  private buf: Uint8ClampedArray;

  constructor(width: number, height: number, bg: RGBA = rgb("#050816")) {
    this.width = width;
    this.height = height;
    this.buf = new Uint8ClampedArray(width * height * 4);
    this.fillRect(0, 0, width, height, bg);
  }

  get pixels(): Uint8ClampedArray {
    return this.buf;
  }

  setPx(x: number, y: number, c: RGBA): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const a = c[3] / 255;
    // simple alpha blend over existing
    this.buf[i] = Math.round(c[0] * a + this.buf[i]! * (1 - a));
    this.buf[i + 1] = Math.round(c[1] * a + this.buf[i + 1]! * (1 - a));
    this.buf[i + 2] = Math.round(c[2] * a + this.buf[i + 2]! * (1 - a));
    this.buf[i + 3] = 255;
  }

  fillRect(x: number, y: number, w: number, h: number, c: RGBA): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.setPx(xx, yy, c);
  }

  /** Additive radial glow field (screen-like) — for nebula backgrounds. */
  addRadialGlow(cx: number, cy: number, radius: number, c: RGBA, strength = 1): void {
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(this.width - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(this.height - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d2 > r2) continue;
        const fall = 1 - d2 / r2;
        const k = fall * fall * strength;
        const i = (y * this.width + x) * 4;
        this.buf[i] = Math.min(255, this.buf[i]! + Math.round(c[0] * k * 0.9));
        this.buf[i + 1] = Math.min(255, this.buf[i + 1]! + Math.round(c[1] * k * 0.9));
        this.buf[i + 2] = Math.min(255, this.buf[i + 2]! + Math.round(c[2] * k * 0.9));
      }
    }
  }

  fillCircle(cx: number, cy: number, r: number, c: RGBA): void {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d2 <= r2) this.setPx(x, y, c);
      }
    }
  }

  fillRoundRect(x: number, y: number, w: number, h: number, r: number, c: RGBA): void {
    this.fillRect(x + r, y, w - 2 * r, h, c);
    this.fillRect(x, y + r, w, h - 2 * r, c);
    for (const [cx, cy] of [[x + r, y + r], [x + w - r - 1, y + r], [x + r, y + h - r - 1], [x + w - r - 1, y + h - r - 1]] as Array<[number, number]>) {
      this.fillCircle(cx + 0.5, cy + 0.5, r, c);
    }
  }

  drawVLine(x: number, y0: number, y1: number, c: RGBA): void {
    for (let y = y0; y <= y1; y++) this.setPx(x, y, c);
  }

  drawHLine(x0: number, x1: number, y: number, c: RGBA): void {
    for (let x = x0; x <= x1; x++) this.setPx(x, y, c);
  }

  strokeRoundRect(x: number, y: number, w: number, h: number, r: number, c: RGBA, thickness = 1): void {
    const k = thickness;
    // top/bottom edges
    for (let i = 0; i < k; i++) {
      this.drawHLine(x + r, x + w - r - 1, y + i, c);
      this.drawHLine(x + r, x + w - r - 1, y + h - 1 - i, c);
      this.drawVLine(x + i, y + r, y + h - r - 1, c);
      this.drawVLine(x + w - 1 - i, y + r, y + h - r - 1, c);
    }
    // corner arcs (quarter circles)
    for (const [cx, cy, sx, sy] of [[x + r, y + r, -1, -1], [x + w - r - 1, y + r, 1, -1], [x + r, y + h - r - 1, -1, 1], [x + w - r - 1, y + h - r - 1, 1, 1]] as Array<[number, number, number, number]>) {
      for (let a = 0; a <= 90; a += 6) {
        const rad = (a * Math.PI) / 180;
        const px = Math.round(cx + Math.cos(rad) * r * sx);
        const py = Math.round(cy + Math.sin(rad) * r * sy);
        this.fillCircle(px, py, k * 0.6, c);
      }
    }
  }

  /* ── text ─────────────────────────────────────────────── */

  drawText(text: string, x: number, y: number, c: RGBA, scale = 1): number {
    let cursor = x;
    for (const rawCh of text.toUpperCase()) {
      const glyph = FONT[rawCh] ?? FONT["?"]!;
      drawGlyph(this, glyph, cursor, y, c, scale);
      cursor += (5 + 1) * scale;
    }
    return cursor - x;
  }

  measureText(text: string, scale = 1): number {
    return text.length * (5 + 1) * scale - scale;
  }
}

function drawGlyph(cv: Canvas, glyph: Uint8Array, x: number, y: number, c: RGBA, scale: number): void {
  for (let row = 0; row < 7; row++) {
    const bits = glyph[row]!;
    for (let col = 0; col < 5; col++) {
      if (bits & (1 << (4 - col))) {
        cv.fillRect(x + col * scale, y + row * scale, scale, scale, c);
      }
    }
  }
}

/* ───────── 5x7 bitmap font (uppercase + digits + symbols) ───────── */

const G = (rows: string[]): Uint8Array => {
  const out = new Uint8Array(7);
  for (let i = 0; i < 7; i++) out[i] = parseInt(rows[i] ?? "00000", 2);
  return out;
};

const FONT: Record<string, Uint8Array> = {
  " ": G(["00000","00000","00000","00000","00000","00000","00000"]),
  A: G(["01110","10001","10001","11111","10001","10001","10001"]),
  B: G(["11110","10001","10001","11110","10001","10001","11110"]),
  C: G(["01110","10001","10000","10000","10000","10001","01110"]),
  D: G(["11110","10001","10001","10001","10001","10001","11110"]),
  E: G(["11111","10000","10000","11110","10000","10000","11111"]),
  F: G(["11111","10000","10000","11110","10000","10000","10000"]),
  G: G(["01110","10001","10000","10111","10001","10001","01111"]),
  H: G(["10001","10001","10001","11111","10001","10001","10001"]),
  I: G(["11111","00100","00100","00100","00100","00100","11111"]),
  J: G(["00111","00010","00010","00010","00010","10010","01100"]),
  K: G(["10001","10010","10100","11000","10100","10010","10001"]),
  L: G(["10000","10000","10000","10000","10000","10000","11111"]),
  M: G(["10001","11011","10101","10101","10001","10001","10001"]),
  N: G(["10001","11001","10101","10011","10001","10001","10001"]),
  O: G(["01110","10001","10001","10001","10001","10001","01110"]),
  P: G(["11110","10001","10001","11110","10000","10000","10000"]),
  Q: G(["01110","10001","10001","10001","10101","10010","01101"]),
  R: G(["11110","10001","10001","11110","10100","10010","10001"]),
  S: G(["01111","10000","10000","01110","00001","00001","11110"]),
  T: G(["11111","00100","00100","00100","00100","00100","00100"]),
  U: G(["10001","10001","10001","10001","10001","10001","01110"]),
  V: G(["10001","10001","10001","10001","01010","01010","00100"]),
  W: G(["10001","10001","10001","10101","10101","11011","10001"]),
  X: G(["10001","01010","00100","00100","00100","01010","10001"]),
  Y: G(["10001","01010","00100","00100","00100","00100","00100"]),
  Z: G(["11111","00001","00010","00100","01000","10000","11111"]),
  "0": G(["01110","10001","10011","10101","11001","10001","01110"]),
  "1": G(["00100","01100","00100","00100","00100","00100","01110"]),
  "2": G(["01110","10001","00001","00010","00100","01000","11111"]),
  "3": G(["11110","00001","00001","01110","00001","00001","11110"]),
  "4": G(["00010","00110","01010","10010","11111","00010","00010"]),
  "5": G(["11111","10000","10000","11110","00001","00001","11110"]),
  "6": G(["00110","01000","10000","11110","10001","10001","01110"]),
  "7": G(["11111","00001","00010","00100","01000","01000","01000"]),
  "8": G(["01110","10001","10001","01110","10001","10001","01110"]),
  "9": G(["01110","10001","10001","01111","00001","00010","01100"]),
  ".": G(["00000","00000","00000","00000","00000","00100","00100"]),
  ",": G(["00000","00000","00000","00000","00100","00100","01000"]),
  ":": G(["00000","00100","00100","00000","00100","00100","00000"]),
  ";": G(["00000","00100","00100","00000","00100","00100","01000"]),
  "-": G(["00000","00000","00000","11111","00000","00000","00000"]),
  "—": G(["00000","00000","00000","11111","00000","00000","00000"]),
  "–": G(["00000","00000","00000","11111","00000","00000","00000"]),
  _: G(["00000","00000","00000","00000","00000","00000","11111"]),
  "/": G(["00001","00010","00010","00100","01000","01000","10000"]),
  "%": G(["11001","11010","00010","00100","01000","01011","10011"]),
  "!": G(["00100","00100","00100","00100","00100","00000","00100"]),
  "?": G(["01110","10001","00001","00010","00100","00000","00100"]),
  "(": G(["00010","00100","01000","01000","01000","00100","00010"]),
  ")": G(["01000","00100","00010","00010","00010","00100","01000"]),
  "#": G(["01010","11111","01010","01010","11111","01010","00000"]),
  "@": G(["01110","10001","10111","10101","10111","10000","01110"]),
  "&": G(["01100","10010","10100","01000","10101","10010","01101"]),
  "*": G(["00100","10101","01110","11111","01110","10101","00100"]),
  "+": G(["00000","00100","00100","11111","00100","00100","00000"]),
  "=": G(["00000","00000","11111","00000","11111","00000","00000"]),
  "'": G(["00100","00100","01000","00000","00000","00000","00000"]),
  '"': G(["01010","01010","01010","00000","00000","00000","00000"]),
  ">": G(["10000","01000","00100","00010","00100","01000","10000"]),
  "|": G(["00100","00100","00100","00100","00100","00100","00100"]),
  "<": G(["00010","00100","01000","10000","01000","00100","00010"]),
  "~": G(["00000","00000","01001","10110","10110","01001","00000"]),
  "✓": G(["00000","00001","00010","10100","01000","00000","00000"]),
  "✗": G(["10001","01010","00100","00100","01010","10001","10001"]),
  "●": G(["00000","00100","01110","01110","01110","00100","00000"]),
  "○": G(["00000","01110","10001","10001","10001","01110","00000"]),
  "█": G(["11111","11111","11111","11111","11111","11111","11111"]),
  "░": G(["10101","01010","10101","01010","10101","01010","10101"]),
};

/* ───────────────────────── GIF encoding ───────────────────────── */

export interface GifFrame {
  canvas: Canvas;
  delay: number; // ms
}

export function writeGif(path: string, frames: GifFrame[], colors = 256): void {
  if (frames.length === 0) throw new Error("no frames");
  const { width, height } = frames[0]!.canvas;
  const gif = GIFEncoder();
  for (const frame of frames) {
    const pixels = frame.canvas.pixels;
    const palette = quantize(pixels, colors);
    const index = applyPalette(pixels, palette);
    gif.writeFrame(index, width, height, { palette, delay: frame.delay });
  }
  gif.finish();
  writeFileSync(path, Buffer.from(gif.bytesView()));
}
