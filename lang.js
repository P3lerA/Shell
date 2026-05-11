const html = document.documentElement;
const btn = document.querySelector('.lang-toggle');
if (btn) btn.addEventListener('click', () => {
  const next = html.dataset.lang === 'zh' ? 'en' : 'zh';
  html.dataset.lang = next;
  html.lang = next;
  localStorage.setItem('lang', next);
  const u = new URL(location.href);
  if (next === 'en') u.searchParams.delete('lang');
  else u.searchParams.set('lang', 'zh');
  history.replaceState({}, '', u);
});
