// Undo/redo: full-document JSON snapshot stacks.
//
// commit() is called with the *pre-mutation* serialized document right
// before each mutation; undo/redo swap the live state across the stacks.
// Rapid same-source edits (typing, slider drags) pass a coalesce key so a
// burst collapses into a single undo step: while the same key keeps
// arriving within the window, only the first pre-burst snapshot is kept.

const COALESCE_MS = 1000;

export class History {
  constructor(maxEntries = 100, maxBytes = 8 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.undoStack = [];
    this.redoStack = [];
    this._lastKey = null;
    this._lastTime = 0;
  }

  commit(state, coalesceKey = null) {
    const now = performance.now();
    if (
      coalesceKey &&
      coalesceKey === this._lastKey &&
      now - this._lastTime < COALESCE_MS
    ) {
      this._lastTime = now;
      return;
    }
    this._lastKey = coalesceKey;
    this._lastTime = now;
    if (this.undoStack[this.undoStack.length - 1] === state) return;
    this.undoStack.push(state);
    this.redoStack.length = 0;
    this._trim();
  }

  undo(currentState) {
    if (!this.undoStack.length) return null;
    this.redoStack.push(currentState);
    this._lastKey = null; // next edit after an undo always snapshots fresh
    return this.undoStack.pop();
  }

  redo(currentState) {
    if (!this.redoStack.length) return null;
    this.undoStack.push(currentState);
    this._lastKey = null;
    return this.redoStack.pop();
  }

  _trim() {
    while (this.undoStack.length > this.maxEntries) this.undoStack.shift();
    let bytes = 0;
    for (const s of this.undoStack) bytes += s.length;
    while (bytes > this.maxBytes && this.undoStack.length > 1) {
      bytes -= this.undoStack.shift().length;
    }
  }
}
