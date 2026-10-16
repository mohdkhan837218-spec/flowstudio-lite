'use strict';

/**
 * FlowStudio Lite — in-app video preview page (v2.0.0).
 * The main process passes ?src=<file:// URL>&autoplay=0|1&title=<name>.
 * This page never receives a raw path from the main window's renderer —
 * the file was validated in the main process (task row + media roots +
 * extension allowlist) before this window was created.
 */
(function () {
  const params = new URLSearchParams(window.location.search);
  const src = params.get('src') || '';
  const title = params.get('title') || 'Video Preview';
  const autoplay = params.get('autoplay') === '1';

  const titleEl = document.getElementById('preview-title');
  const video = document.getElementById('preview-video');
  if (titleEl) titleEl.textContent = title;
  document.title = `Preview — ${title}`;

  // Keep the theme consistent with the main window's saved appearance
  // (the main process passes it through as ?theme=dark|white|system).
  const theme = params.get('theme') || 'dark';
  const resolved = theme === 'system'
    ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'white' : 'dark')
    : theme;
  if (resolved === 'white') document.documentElement.setAttribute('data-theme', 'white');

  if (video && src) {
    video.src = src;
    if (autoplay) {
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }
})();
