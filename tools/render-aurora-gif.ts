/**
 * Renders a stylized recreation of the AURORA landing page as an animated GIF.
 * Stars twinkle, a shooting star crosses periodically, the clock ticks.
 *
 *   npx tsx tools/render-aurora-gif.ts examples/aurora-showcase/aurora-page.gif
 */
import { Canvas, rgb, writeGif, type GifFrame } from "./gifkit.js";

const W = 640, H = 360;
const ACCENT = rgb("#8b5cf6"), CYAN = rgb("#22d3ee"), TEXT = rgb("#e6e9f5");
const MUTED = rgb("#8a90b4"), CARD = rgb("#161b3d"), CARD_EDGE = rgb("#2a2f5e");

// deterministic pseudo-random starfield
let seed = 1234567;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const stars = Array.from({ length: 130 }, () => ({ x: rand() * W, y: rand() * H, r: 0.4 + rand() * 1.1, ph: rand() * Math.PI * 2 }));

const FRAMES = 18;
const frames: GifFrame[] = [];

for (let f = 0; f < FRAMES; f++) {
  const t = f * 90;
  const c = new Canvas(W, H, rgb("#050816"));

  // nebula glows (aurora-ish)
  c.addRadialGlow(W * 0.12, -H * 0.15, 240, rgb("#5b2bd9"), 0.85);
  c.addRadialGlow(W * 0.95, H * 0.12, 220, rgb("#0f6f8c"), 0.85);
  c.addRadialGlow(W * 0.55, H * 1.15, 260, rgb("#8c2bd0"), 0.8);

  // twinkling stars
  for (const s of stars) {
    const tw = 0.35 + 0.65 * Math.abs(Math.sin(t / 480 + s.ph));
    c.fillCircle(s.x, s.y, s.r, [255, 255, 255, Math.round(255 * tw)]);
  }

  // periodic shooting star (frames 6..9)
  if (f >= 6 && f <= 9) {
    const p = (f - 6) / 3;
    const sx = W * (0.75 - p * 0.5), sy = H * (0.08 + p * 0.22);
    for (let i = 0; i < 10; i++) {
      const k = i / 9;
      c.fillCircle(sx - i * 7, sy - i * 4, 1.6 * (1 - k) + 0.3, [255, 255, 255, Math.round(255 * (1 - k) * 0.9)]);
    }
  }

  // nav
  c.drawText("A U R O R A", 28, 16, TEXT, 2);
  const nav = "Work  About  Contact";
  c.drawText(nav, W - c.measureText(nav, 1) - 24, 20, MUTED, 1);

  // hero
  c.drawText("BUILDING CALM", 28, 66, TEXT, 4);
  c.drawText("SOFTWARE.", 28, 98, TEXT, 4);
  c.drawText("I DESIGN AND SHIP SMALL, HONEST TOOLS.", 28, 140, MUTED, 1);

  // CTA button with subtle pulse
  const pulse = 0.75 + 0.25 * Math.sin(t / 380);
  c.fillRoundRect(28, 164, 132, 20, 10, [Math.round(139 * pulse + 40), Math.round(92 * pulse + 60), Math.round(246 * pulse), 255]);
  c.drawText("SEE THE WORK >", 44, 170, rgb("#0b0a1a"), 1);

  // project cards
  const cards = [
    { title: "PRISM", line1: "A log lens for", line2: "Node services." },
    { title: "CIRRUS", line1: "Pocket weather,", line2: "read in 2 seconds." },
    { title: "NOTES-API", line1: "Tiny REST notes,", line2: "one file of code." },
  ];
  const cardY = 198, cardH = 108, cardW = 178, gap = 12;
  for (let i = 0; i < cards.length; i++) {
    const x = 28 + i * (cardW + gap);
    c.fillRoundRect(x, cardY, cardW, cardH, 10, CARD);
    c.strokeRoundRect(x, cardY, cardW, cardH, 10, CARD_EDGE, 1);
    c.drawText(cards[i]!.title, x + 14, cardY + 14, TEXT, 1);
    c.drawText(cards[i]!.line1, x + 14, cardY + 34, MUTED, 1);
    c.drawText(cards[i]!.line2, x + 14, cardY + 48, MUTED, 1);
    c.drawText("DETAILS >", x + 14, cardY + 78, CYAN, 1);
  }

  // footer
  const clock = new Date(Date.UTC(2026, 10, 12, 3, 17, (f * 2) % 60));
  const hhmmss = clock.toISOString().slice(11, 19);
  c.drawText("BUILT BY THREE MCP AGENTS - AURORA-SHOWCASE", 28, 332, MUTED, 1);
  c.drawText(hhmmss, W - c.measureText(hhmmss, 1) - 24, 332, CYAN, 1);

  frames.push({ canvas: c, delay: 90 });
}

const out = process.argv[2] ?? "examples/aurora-showcase/aurora-page.gif";
writeGif(out, frames);
console.log("wrote", out, `${frames.length} frames`);
