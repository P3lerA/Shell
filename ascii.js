/* The twin sacred trees. Oraculum grows upward (it creates memory); Augurium
   is its mirror below the axis and runs backwards (it reverses time). So the
   loop has to return to where it started -- Augurium cannot grow while the
   heart it is rooted in still beats.

   Only the upper half is drawn. The lower half is the same frames read from
   the other end, flipped, with the slashes swapped. */

const HALF = [
  ['                         ',
   '                         ',
   '                         ',
   '            .            '],
  ['                         ',
   '                         ',
   '            |            ',
   '            |            '],
  ['                         ',
   '           \\|/           ',
   '            |            ',
   '            |            '],
  ['          \\ | /          ',
   '           \\|/           ',
   '            |            ',
   '            |            '],
  ['         \\\\ | //         ',
   '          \\ | /          ',
   '           \\|/           ',
   '            |            '],
  ['        \\\\\\ | ///        ',
   '         \\\\ | //         ',
   '          \\ | /          ',
   '           \\|/           '],
];

const AXIS = '-'.repeat(12) + '+' + '-'.repeat(12);

const flip = rows => rows
  .slice().reverse()
  .map(r => r.replace(/[\\/]/g, c => (c === '\\' ? '/' : '\\')));

const frame = i => [...HALF[i], AXIS, ...flip(HALF[HALF.length - 1 - i])].join('\n');

// grow, then unwind — the same frames back down, without repeating the ends
const order = [...HALF.keys(), ...[...HALF.keys()].reverse().slice(1, -1)];

const el = document.getElementById('hero');
if (el) {
  el.textContent = frame(order[0]);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let k = 0;
    setInterval(() => {
      k = (k + 1) % order.length;
      el.textContent = frame(order[k]);
    }, 260);                                  // ~4fps: slow enough to read as deliberate
  }
}
