// Typewriter effect for the site title.
// The full text stays in the HTML for no-JS / screen readers;
// with JS we retype it character by character, then "type" the
// theme dot as the final keystroke, and leave a blinking cursor.
//
// No real API — everything is driven by the markup:
//   <h1 class="site-title" data-typewriter="the Shell">
//     the Shell<button class="theme-toggle">…</button>  <!-- the "period" -->
//   </h1>
(() => {
  const el = document.querySelector('.site-title[data-typewriter]');
  if (!el) return;

  const text = el.dataset.typewriter || el.textContent.trim();
  const dot = el.querySelector('.theme-toggle');

  // detach the dot before clearing; hide the title before retyping
  // (deferred script runs before first paint, so no flash) — if this
  // file never loads, the static markup simply stays visible
  if (dot) dot.remove();
  el.style.visibility = 'hidden';

  // keep the real text accessible while we visually retype it
  el.setAttribute('aria-label', text);
  el.textContent = '';

  const node = document.createTextNode('');
  const cursor = document.createElement('span');
  cursor.className = 'tw-cursor';
  cursor.setAttribute('aria-hidden', 'true');
  el.append(node, cursor);
  el.style.visibility = 'visible';

  // the dot is "typed" last: re-inserted between text and cursor once
  // the text is done — the cursor stays put and the period lands
  // in front of it
  if (dot) {
    dot.style.visibility = 'hidden';
    dot.tabIndex = -1;
  }
  const typeDot = () => {
    if (!dot) return;
    el.insertBefore(dot, cursor);
    dot.style.visibility = 'visible';
    dot.removeAttribute('tabindex');
  };

  let i = 0;
  const tick = () => {
    if (i >= text.length) {
      // one beat after the last letter, then the period lands
      setTimeout(typeDot, 260);
      return;
    }
    node.textContent += text[i++];
    // slightly uneven cadence feels more like typing
    setTimeout(tick, 60 + Math.random() * 110);
  };
  setTimeout(tick, 350);
})();
