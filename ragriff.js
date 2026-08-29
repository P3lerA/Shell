/* A page of text with the word cut out of it.

   Lines of the wiki's own names and openings enter at the top as illegible
   grain and resolve as they descend — each cell has a fixed threshold, so a
   character that surfaces stays surfaced and a line settles into itself on
   the way down. Density never changes: an unresolved cell holds grain, not
   emptiness, so the only void on the page is RAGRIFF itself.

   One row per step, ~1.4fps. No canvas, no dependencies. */

const CORPUS = (window.RAGRIFF_CORPUS || []).filter(s => s && s.length > 3);

const FONT = {
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  G: ['.####', '#....', '#....', '#..##', '#...#', '#...#', '.####'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
};

const WORD = 'RAGRIFF';
const GW = 5, GH = 7, GAP = 2;
const SX = 2;                    // a monospace cell is ~2x as tall as it is wide
const W = 88, H = 24;
const STEP_MS = 700;             // ~1.4fps: each line is a move, not a transition
const FADE = 0.35;               // opacity of the farthest row

const x0 = Math.floor((W - (WORD.length * GW * SX + (WORD.length - 1) * GAP)) / 2);
const y0 = Math.floor((H - GH) / 2);

const hole = new Set();
[...WORD].forEach((ch, li) => {
  FONT[ch].forEach((row, r) => {
    [...row].forEach((c, k) => {
      if (c !== '#') return;
      const cx = x0 + li * (GW * SX + GAP) + k * SX;
      for (let s = 0; s < SX; s++) hole.add((y0 + r) * W + cx + s);
    });
  });
});

// the grain is made of the same material as the text, so it reads as decay
// rather than as static
const ALPHABET = [...new Set(CORPUS.join(''))].filter(c => c !== ' ');
const grain = () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)] || '.';
const pick = () => CORPUS[Math.floor(Math.random() * CORPUS.length)] || '';

function newRow() {
  let text = '';
  while (text.length < W) text += pick() + '   ';
  return {
    text: text.slice(0, W),
    noise: Array.from({ length: W }, grain),
    // how far down a cell must travel before it settles; squared to bias the
    // thresholds low, so a line starts surfacing early and is legible well
    // before it reaches the reader
    at: Array.from({ length: W }, () => Math.random() ** 2),
  };
}

const el = document.getElementById('hero');
const rows = Array.from({ length: H }, newRow);
const lines = [];

if (el && CORPUS.length) {
  for (let y = 0; y < H; y++) {
    const span = document.createElement('span');
    span.style.opacity = (FADE + (1 - FADE) * (y / (H - 1))).toFixed(3);
    el.append(span, '\n');
    lines.push(span);
  }

  const draw = () => rows.forEach((row, y) => {
    const depth = y / (H - 1);                       // 0 at the horizon, 1 at the reader
    let out = '';
    for (let x = 0; x < W; x++) {
      out += hole.has(y * W + x) ? ' '
        : row.at[x] <= depth ? row.text[x]
        : row.noise[x];
    }
    lines[y].textContent = out;
  });

  draw();
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setInterval(() => {
      rows.pop();
      rows.unshift(newRow());
      draw();
    }, STEP_MS);
  }
}
