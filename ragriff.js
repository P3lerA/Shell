/* The gate builds its own name out of its own source.

   A block of text fills the panel; everything that is not part of the
   letterform erodes away a handful of cells at a time until only the
   characters standing inside RAGRIFF are left. ~1.4fps, so each step is a
   deliberate move rather than a transition.

   SOURCE is the page's own markup. Swap it for an essay, a chapter, anything
   with characters -- the shape does not care what it is made of. */

const SOURCE = () => document.documentElement.outerHTML.replace(/\s+/g, '');

const FONT = {
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  G: ['.####', '#....', '#....', '#..##', '#...#', '#...#', '.####'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
};

const WORD = 'RAGRIFF';
const GW = 5, GH = 7, GAP = 2;              // glyph cell, and the gap between glyphs
const SX = 2;                               // a monospace cell is about twice as tall as it
                                            // is wide, so stretch the glyphs back to square
const W = 88, H = 15;                       // panel
const STEP_MS = 700;                        // ~1.4fps
const STEPS = 13;
const HOLD_MS = 4200;                       // how long the finished word stands

const x0 = Math.floor((W - (WORD.length * GW * SX + (WORD.length - 1) * GAP)) / 2);
const y0 = Math.floor((H - GH) / 2);

const mask = new Set();
[...WORD].forEach((ch, li) => {
  FONT[ch].forEach((row, r) => {
    [...row].forEach((c, k) => {
      if (c !== '#') return;
      const cx = x0 + li * (GW * SX + GAP) + k * SX;
      for (let s = 0; s < SX; s++) mask.add((y0 + r) * W + cx + s);
    });
  });
});

const el = document.getElementById('hero');

function shuffled(xs) {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function draw(cells) {
  let out = '';
  for (let y = 0; y < H; y++) out += cells.slice(y * W, y * W + W).join('') + '\n';
  el.textContent = out;
}

function run() {
  const src = SOURCE();
  const cells = Array.from({ length: W * H }, (_, i) => src[i % src.length] || '.');
  const loose = shuffled([...Array(W * H).keys()].filter(i => !mask.has(i)));
  const per = Math.ceil(loose.length / STEPS);

  draw(cells);
  let step = 0;
  const tick = () => {
    for (const i of loose.slice(step * per, (step + 1) * per)) cells[i] = ' ';
    draw(cells);
    step++;
    setTimeout(step < STEPS ? tick : run, step < STEPS ? STEP_MS : HOLD_MS);
  };
  setTimeout(tick, STEP_MS);
}

if (el) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const src = SOURCE();
    draw(Array.from({ length: W * H }, (_, i) => (mask.has(i) ? src[i % src.length] || '.' : ' ')));
  } else {
    run();
  }
}
