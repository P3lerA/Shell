document.querySelector('.theme-toggle').addEventListener('click', () => {
  const html = document.documentElement;
  const isDark = (html.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  html.dataset.theme = isDark ? 'light' : 'dark';
  localStorage.setItem('theme', html.dataset.theme);
});
