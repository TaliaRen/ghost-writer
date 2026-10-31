// Editor controller: a real <textarea> for input (caret, selection, IME, paste)
// layered over a "backdrop" div that renders the same text. The backdrop lets us
// measure any character range with DOM Ranges and hide text while its ghost is
// still flying home, so restored text never appears twice.

import { GhostLayer, type Box, type Point } from './ghosts';
import { diffText, hasVisible, trimOffsets } from './text';

interface Op {
  start: number;
  removed: string;
  inserted: string;
  selBefore: [number, number];
  selAfter: [number, number];
  ghostId: number | null;
  time: number;
  open: boolean; // can still merge with the next edit
  kind: 'insert' | 'delete' | 'replace';
  backward: boolean; // deletion grew leftwards (backspace)
}

interface Mark {
  start: number;
  end: number;
  cls: 'hold' | 'reveal';
  id?: number;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  /** Some deleted text is still waiting in the history to be brought back. */
  hasDeletion: boolean;
}

export interface EditorElements {
  root: HTMLElement; // positioned container for the ghost layer
  layer: HTMLElement;
  sky: HTMLElement;
  wrap: HTMLElement;
  textarea: HTMLTextAreaElement;
  backdrop: HTMLElement;
}

const HISTORY_LIMIT = 500;

export class GhostWriter {
  private ta: HTMLTextAreaElement;
  private bd: HTMLElement;
  private ghosts: GhostLayer;
  private value: string;
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  private composing = false;
  private compSel: [number, number] | null = null;
  private selBefore: [number, number] | null = null;
  private lastSel: [number, number] = [0, 0]; // fallback when beforeinput is missing
  private inputType = '';
  private deleteRepeat = false;
  private holds = new Map<number, Mark>(); // ghostId -> hidden range
  private reveals: Mark[] = [];
  private nodes: { node: Text; start: number; end: number }[] = [];
  private fontSize = 32;

  constructor(private els: EditorElements, private onHistory: (h: HistoryState) => void) {
    this.ta = els.textarea;
    this.bd = els.backdrop;
    this.value = this.ta.value;
    this.ghosts = new GhostLayer(els.layer, {
      sky: () => this.toLayer(els.sky.getBoundingClientRect()),
      editor: () => this.toLayer(els.wrap.getBoundingClientRect()),
      editorFontSize: () => this.fontSize,
      onLanded: (id) => this.landed(id),
    });
    this.readFont();
    this.render();

    const ta = this.ta;
    ta.addEventListener('keydown', this.onKeyDown);
    ta.addEventListener('beforeinput', this.onBeforeInput);
    ta.addEventListener('input', this.onInput);
    ta.addEventListener('compositionstart', this.onCompStart);
    ta.addEventListener('compositionend', this.onCompEnd);
    ta.addEventListener('pointerdown', this.closeGroup);
    ta.addEventListener('blur', this.closeGroup);
    window.addEventListener('resize', this.onResize);
    document.addEventListener('selectionchange', this.onSelectionChange);
    this.lastSel = [ta.selectionStart, ta.selectionEnd];
    document.fonts?.ready.then(() => {
      this.readFont();
      this.render();
    });
  }

  destroy() {
    const ta = this.ta;
    ta.removeEventListener('keydown', this.onKeyDown);
    ta.removeEventListener('beforeinput', this.onBeforeInput);
    ta.removeEventListener('input', this.onInput);
    ta.removeEventListener('compositionstart', this.onCompStart);
    ta.removeEventListener('compositionend', this.onCompEnd);
    ta.removeEventListener('pointerdown', this.closeGroup);
    ta.removeEventListener('blur', this.closeGroup);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('selectionchange', this.onSelectionChange);
    this.ghosts.destroy();
  }

  // ------------------------------------------------------------- input events

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && key === 'y') {
      e.preventDefault();
      this.redo();
      return;
    }
    this.deleteRepeat = (e.key === 'Backspace' || e.key === 'Delete') && e.repeat;
    this.lastSel = [this.ta.selectionStart, this.ta.selectionEnd];
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key.startsWith('Page')) {
      this.closeGroup();
    }
  };

  private onBeforeInput = (e: InputEvent) => {
    if (e.inputType === 'historyUndo') {
      e.preventDefault();
      this.undo();
      return;
    }
    if (e.inputType === 'historyRedo') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (this.composing) return;
    this.inputType = e.inputType;
    this.selBefore = [this.ta.selectionStart, this.ta.selectionEnd];
  };

  private onInput = (e: Event) => {
    if (this.composing || (e as InputEvent).isComposing) return;
    this.commit();
  };

  private onCompStart = () => {
    this.composing = true;
    this.compSel = [this.ta.selectionStart, this.ta.selectionEnd];
    // While composing, the textarea paints its own text (with the IME
    // underline) and the backdrop keeps the last committed layout.
    this.els.wrap.classList.add('composing');
  };

  private onCompEnd = () => {
    this.composing = false;
    this.els.wrap.classList.remove('composing');
    this.inputType = 'insertCompositionText';
    this.selBefore = this.compSel;
    this.compSel = null;
    // Some browsers update the value after compositionend; commit() is
    // idempotent, so commit now and again on the following input event.
    this.commit();
  };

  private onSelectionChange = () => {
    if (document.activeElement === this.ta && !this.composing) {
      this.lastSel = [this.ta.selectionStart, this.ta.selectionEnd];
    }
  };

  private onResize = () => {
    this.readFont();
  };

  private closeGroup = () => {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top) top.open = false;
  };

  // ------------------------------------------------------------ edit pipeline

  /** Turn whatever the textarea now contains into a recorded edit. */
  private commit() {
    const next = this.ta.value;
    const prev = this.value;
    const change = diffText(prev, next, this.ta.selectionEnd);
    const inputType = this.inputType;
    const selBefore = this.selBefore ?? this.lastSel;
    this.inputType = '';
    this.selBefore = null;
    if (!change) return;

    const { start, removed, inserted } = change;
    const hadSelection = selBefore[0] !== selBefore[1];
    const isDelete = inputType.startsWith('delete') || (!inserted && !inputType);
    const wantsGhost =
      hasVisible(removed) && inputType !== 'deleteByDrag' && (isDelete || hadSelection || !inserted);

    // Measure the doomed text while the backdrop still shows it.
    const origin = wantsGhost ? this.measure(start, removed) : null;

    this.value = next;
    this.shiftMarks(start, removed.length, inserted.length);
    this.render();
    this.lastSel = [this.ta.selectionStart, this.ta.selectionEnd];

    const now = performance.now();
    const kind: Op['kind'] = !removed ? 'insert' : !inserted ? 'delete' : 'replace';
    const top = this.undoStack[this.undoStack.length - 1];
    const op: Op = {
      start,
      removed,
      inserted,
      selBefore,
      selAfter: [this.ta.selectionStart, this.ta.selectionEnd],
      ghostId: null,
      time: now,
      open: true,
      kind,
      backward: false,
    };

    if (top && top.open && this.tryMerge(top, op, now, origin)) {
      this.redoStack = [];
      this.emit();
      return;
    }

    if (wantsGhost && origin) {
      op.ghostId = this.ghosts.newId();
      this.ghosts.spawn(op.ghostId, removed, origin);
    }
    this.push(op);
  }

  private tryMerge(top: Op, op: Op, now: number, origin: Point | null): boolean {
    const dt = now - top.time;
    if (top.kind === 'insert' && op.kind === 'insert') {
      if (dt > 1200 || op.start !== top.start + top.inserted.length) return false;
      if (op.inserted.includes('\n')) return false;
      // Undo word by word: start a new group after whitespace.
      if (/\s$/u.test(top.inserted) && /\S/u.test(op.inserted)) return false;
      top.inserted += op.inserted;
      top.selAfter = op.selAfter;
      top.time = now;
      return true;
    }
    // Only caret deletions merge (held backspace); a selection deletion stands alone.
    if (top.kind === 'delete' && op.kind === 'delete' && op.selBefore[0] === op.selBefore[1] && top.selBefore[0] === top.selBefore[1]) {
      const window = this.deleteRepeat ? 1000 : 320;
      if (dt > window) return false;
      let merged: string;
      if (op.start + op.removed.length === top.start) {
        merged = op.removed + top.removed; // backspace
        top.start = op.start;
        top.backward = true;
      } else if (op.start === top.start) {
        merged = top.removed + op.removed; // forward delete
      } else return false;
      top.removed = merged;
      top.selAfter = op.selAfter;
      top.time = now;
      if (hasVisible(merged)) {
        if (top.ghostId != null && this.ghosts.grow(top.ghostId, merged, origin)) return true;
        if (top.ghostId == null || !this.ghosts.isAlive(top.ghostId)) {
          const at = origin ?? this.measure(top.start, merged);
          if (at) {
            top.ghostId = top.ghostId ?? this.ghosts.newId();
            this.ghosts.spawn(top.ghostId, merged, at);
          }
        }
      }
      return true;
    }
    return false;
  }

  private push(op: Op) {
    this.closeGroup();
    this.undoStack.push(op);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
  }

  undo() {
    if (this.composing) return;
    const op = this.undoStack.pop();
    if (!op) return;
    op.open = false;
    const v = this.value;
    const next = v.slice(0, op.start) + op.removed + v.slice(op.start + op.inserted.length);
    this.apply(next, op.start, op.inserted.length, op.removed.length);

    const ghost = op.ghostId != null && hasVisible(op.removed);
    let hold: Mark | null = null;
    if (ghost) {
      // Text is back immediately (logically); visually it stays hidden until
      // the ghost lands on it.
      hold = { start: op.start, end: op.start + op.removed.length, cls: 'hold', id: op.ghostId! };
      this.holds.set(op.ghostId!, hold);
    }
    this.render();
    this.ta.setSelectionRange(op.selBefore[0], op.selBefore[1]);
    this.lastSel = [...op.selBefore];
    if (ghost) {
      const to = this.measure(op.start, op.removed);
      const id = op.ghostId!;
      if (to) this.ghosts.recall(id, op.removed, to);
      else this.landed(id);
      // Safety net: if frames are paused (background tab), never leave the
      // restored text invisible.
      window.setTimeout(() => {
        if (hold && this.holds.get(id) === hold) {
          this.ghosts.dismiss(id);
          this.landed(id);
        }
      }, 1500);
    }
    this.redoStack.push(op);
    this.emit();
  }

  redo() {
    if (this.composing) return;
    const op = this.redoStack.pop();
    if (!op) return;
    this.closeGroup();
    // If the ghost is still flying home to this text, it simply turns around.
    if (op.ghostId != null) this.holds.delete(op.ghostId);
    const ghost = hasVisible(op.removed);
    const origin = ghost ? this.measure(op.start, op.removed) : null;
    const v = this.value;
    const next = v.slice(0, op.start) + op.inserted + v.slice(op.start + op.removed.length);
    this.apply(next, op.start, op.removed.length, op.inserted.length);
    this.render();
    this.ta.setSelectionRange(op.selAfter[0], op.selAfter[1]);
    this.lastSel = [...op.selAfter];
    if (ghost && origin) {
      op.ghostId = op.ghostId ?? this.ghosts.newId();
      this.ghosts.spawn(op.ghostId, op.removed, origin);
    }
    op.open = false;
    this.undoStack.push(op);
    this.emit();
  }

  private apply(next: string, start: number, removedLen: number, insertedLen: number) {
    this.value = next;
    this.ta.value = next;
    this.shiftMarks(start, removedLen, insertedLen);
  }

  /** Keep hidden/reveal ranges attached to their text across edits. */
  private shiftMarks(start: number, removedLen: number, insertedLen: number) {
    const end = start + removedLen;
    const delta = insertedLen - removedLen;
    for (const [id, m] of [...this.holds]) {
      const before = removedLen === 0 ? start <= m.start : end <= m.start;
      const after = start >= m.end;
      if (before) {
        m.start += delta;
        m.end += delta;
      } else if (!after) {
        // The edit touched text that is still waiting for its ghost: land now.
        this.holds.delete(id);
        this.ghosts.dismiss(id);
      }
    }
    this.reveals = [];
  }

  private landed(id: number) {
    const m = this.holds.get(id);
    if (!m) return;
    this.holds.delete(id);
    this.reveals.push({ start: m.start, end: m.end, cls: 'reveal' });
    this.render();
  }

  private emit() {
    this.onHistory({
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      hasDeletion: this.undoStack.some((op) => op.removed.length > 0),
    });
  }

  // --------------------------------------------------------------- rendering

  private render() {
    const v = this.value;
    const bd = this.bd;
    const marks = [...this.holds.values(), ...this.reveals]
      .filter((m) => m.end > m.start && m.end <= v.length)
      .sort((a, b) => a.start - b.start);
    bd.textContent = '';
    this.nodes = [];
    let pos = 0;
    const addText = (s: string, at: number, parent: Node) => {
      const node = document.createTextNode(s);
      parent.appendChild(node);
      this.nodes.push({ node, start: at, end: at + s.length });
    };
    for (const m of marks) {
      if (m.start < pos) continue; // overlapping marks: keep the first
      if (m.start > pos) addText(v.slice(pos, m.start), pos, bd);
      const span = document.createElement('span');
      span.className = m.cls;
      addText(v.slice(m.start, m.end), m.start, span);
      bd.appendChild(span);
      pos = m.end;
    }
    if (pos < v.length) addText(v.slice(pos), pos, bd);
    if (!v) {
      const ph = document.createElement('span');
      ph.className = 'placeholder';
      ph.textContent = 'Write something you might regret…';
      bd.appendChild(ph);
    } else if (v.endsWith('\n')) {
      bd.appendChild(document.createTextNode('​'));
    }
  }

  private locate(offset: number, preferNext: boolean): [Text, number] | null {
    const list = this.nodes;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (offset < n.end || (offset === n.end && (!preferNext || i === list.length - 1))) {
        if (offset >= n.start) return [n.node, offset - n.start];
      }
    }
    return null;
  }

  /**
   * Centre of the first line of the visible part of `text` sitting at `start`
   * in the current backdrop, in layer coordinates.
   */
  private measure(start: number, text: string): Point | null {
    const [a, b] = trimOffsets(text);
    if (b <= a) return null;
    const s = this.locate(start + a, true);
    const e = this.locate(start + b, false);
    if (!s || !e) return null;
    const range = document.createRange();
    range.setStart(s[0], s[1]);
    range.setEnd(e[0], e[1]);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0);
    if (!rects.length) return null;
    const first = rects[0];
    const line = rects.filter((r) => Math.abs(r.top - first.top) < 2);
    const left = Math.min(...line.map((r) => r.left));
    const right = Math.max(...line.map((r) => r.right));
    const box = this.toLayer({ left, right, top: first.top, bottom: first.bottom } as DOMRect);
    return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  }

  private toLayer(r: { left: number; right: number; top: number; bottom: number }): Box {
    const o = this.els.layer.getBoundingClientRect();
    return { left: r.left - o.left, right: r.right - o.left, top: r.top - o.top, bottom: r.bottom - o.top };
  }

  private readFont() {
    this.fontSize = parseFloat(getComputedStyle(this.ta).fontSize) || 32;
  }
}
