// Keeps the layout pinned to what the reader can actually see on phones.
//
// iOS does not shrink the page when the soft keyboard opens; it pans the
// visual viewport over the page instead. Left alone, that pans the text box
// up under the status bar and the host app's buttons. So on touch screens the
// page is a fixed, non-scrolling frame that follows the visual viewport
// (--app-height / --vv-top), and while the keyboard is open the box sits just
// above it (.kb-open). Inside the Xiaohongshu mini-tool container, the host's
// top buttons are measured with getWindowInfo and kept clear (--top-reserve).

interface Rect {
  bottom: number;
}

interface WindowInfo {
  statusBarHeight?: number;
  safeArea?: { top?: number } | null;
  menuButtons?: Record<string, Rect | null> | null;
}

interface MiniTool {
  getWindowInfo?: () => Promise<WindowInfo> | undefined;
}

declare global {
  interface Window {
    xhs?: { miniTool?: MiniTool };
  }
}

export function watchViewport(textarea: HTMLTextAreaElement): () => void {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const touch = window.matchMedia('(hover: none) and (pointer: coarse)');
  // Tallest visible height seen at the current width = keyboard closed.
  let baseline = 0;
  let baselineWidth = 0;
  const timers: number[] = [];

  const sync = () => {
    const h = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    const width = window.innerWidth;
    if (Math.abs(width - baselineWidth) > 40) {
      baseline = 0; // rotated / resized: start over
      baselineWidth = width;
    }
    baseline = Math.max(baseline, h);
    root.style.setProperty('--app-height', `${Math.round(h)}px`);
    root.style.setProperty('--vv-top', `${Math.round(top)}px`);
    const keyboardOpen = touch.matches && document.activeElement === textarea && h < baseline * 0.82;
    root.classList.toggle('kb-open', keyboardOpen);
    // The page itself never scrolls on touch screens; undo any pan iOS made.
    if (touch.matches && (window.scrollY || window.scrollX)) window.scrollTo(0, 0);
  };

  // The keyboard animates in; measure again once it has settled.
  const syncSoon = () => {
    sync();
    for (const ms of [60, 300, 600]) timers.push(window.setTimeout(sync, ms));
  };

  sync();
  vv?.addEventListener('resize', sync);
  vv?.addEventListener('scroll', sync);
  window.addEventListener('resize', sync);
  textarea.addEventListener('focus', syncSoon);
  textarea.addEventListener('blur', syncSoon);
  measureHostButtons(root);

  return () => {
    timers.forEach((t) => clearTimeout(t));
    vv?.removeEventListener('resize', sync);
    vv?.removeEventListener('scroll', sync);
    window.removeEventListener('resize', sync);
    textarea.removeEventListener('focus', syncSoon);
    textarea.removeEventListener('blur', syncSoon);
  };
}

/** Inside the mini-tool container, keep content below the host's top buttons. */
function measureHostButtons(root: HTMLElement) {
  const miniTool = window.xhs && window.xhs.miniTool;
  if (!miniTool || typeof miniTool.getWindowInfo !== 'function') return;
  let result: Promise<WindowInfo> | undefined;
  try {
    result = miniTool.getWindowInfo();
  } catch {
    return; // older client: fall back to the CSS safe-area values
  }
  if (!result || typeof result.then !== 'function') return;
  result
    .then((info) => {
      const buttons = info.menuButtons ? Object.keys(info.menuButtons).map((k) => info.menuButtons![k]) : [];
      let bottom = Math.max(info.statusBarHeight || 0, (info.safeArea && info.safeArea.top) || 0);
      for (const b of buttons) if (b && typeof b.bottom === 'number') bottom = Math.max(bottom, b.bottom);
      if (bottom > 0) root.style.setProperty('--top-reserve', `${Math.ceil(bottom + 8)}px`);
    })
    .catch(() => {});
}
