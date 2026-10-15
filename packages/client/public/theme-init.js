// Applies the saved theme before first paint (an external file, so the page needs no inline script).
try {
  var t = localStorage.getItem('pourgate.theme') || 'system';
  if (t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark');
} catch (e) {}
