import { useEffect, useRef, useState } from 'react';
import { GhostWriter } from './ghost/editor';

const INITIAL = 'Tonight, even the words refuse to leave.';

export default function App() {
  const rootRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const skyRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const writer = useRef<GhostWriter | null>(null);
  const [showUndo, setShowUndo] = useState(false);

  useEffect(() => {
    const ta = taRef.current!;
    const w = new GhostWriter(
      {
        root: rootRef.current!,
        layer: layerRef.current!,
        sky: skyRef.current!,
        wrap: wrapRef.current!,
        textarea: ta,
        backdrop: backdropRef.current!,
      },
      (h) => setShowUndo(h.hasDeletion),
    );
    writer.current = w;
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    return () => {
      w.destroy();
      writer.current = null;
    };
  }, []);

  // Clicking the box's padding should still put the caret in the text.
  const focusFromBox = (e: React.MouseEvent) => {
    const ta = taRef.current;
    if (!ta || e.target === ta) return;
    e.preventDefault();
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  };

  return (
    <div className="app" ref={rootRef}>
      <div className="sky" ref={skyRef} aria-hidden="true" />

      <main className="page">
        <div className="editor-anchor">
          <div className="editor" ref={wrapRef} onMouseDown={focusFromBox}>
            <div className="ink backdrop" ref={backdropRef} aria-hidden="true" />
            <textarea
              ref={taRef}
              className="ink input"
              defaultValue={INITIAL}
              spellCheck={false}
              autoCapitalize="sentences"
              aria-label="Ghost Writer text"
              rows={1}
            />
          </div>
          {/* Touch screens have no Cmd/Ctrl+Z, so phones get a quiet undo that
              only appears once something has been deleted. */}
          <button
            type="button"
            className={`touch-undo${showUndo ? ' is-shown' : ''}`}
            aria-label="Undo"
            aria-hidden={!showUndo}
            tabIndex={showUndo ? 0 : -1}
            disabled={!showUndo}
            // Keep the keyboard open: don't let the button take focus.
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => writer.current?.undo()}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>Undo</span>
          </button>
        </div>
      </main>

      <div className="ghost-layer" ref={layerRef} aria-hidden="true" />
    </div>
  );
}
