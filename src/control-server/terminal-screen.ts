/**
 * Replays raw PTY output onto a minimal virtual screen and returns the visible text lines.
 * TUIs repaint with cursor movement and erase sequences; stripping escapes alone would
 * keep every intermediate frame (spinners, half-drawn dialogs) glued together.
 */
/** Cursor columns beyond any real terminal width; escape parameters are clamped so hostile output cannot allocate huge rows. */
const MAX_COLS = 1000;
/** An unterminated OSC/DCS payload longer than this is dropped instead of waiting for its end. */
const MAX_PENDING = 8192;

/**
 * A screen fed chunk by chunk. ConPTY and diffing TUIs redraw only the cells that changed (a countdown's digits, a moved
 * selection marker), so a dialog is only readable on a screen that saw everything drawn before it, not on a recent tail.
 */
export class TerminalScreen {
  private lines: string[][] = [[]];
  private row = 0;
  private col = 0;
  private saved = { row: 0, col: 0 };
  /** An escape sequence cut off at the end of the last chunk. */
  private pending = '';
  private cols = MAX_COLS;
  /** Rows whose text continued on the next row because it reached the width. */
  private wrapped = new WeakSet<string[]>();
  constructor(public rows = 30, private readonly scrollback = 200) {}

  /** The terminal changed size; cells past the new width are gone, as on a real screen. */
  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols; this.rows = rows;
    for (const cells of this.lines) if (cells.length > cols) cells.length = cols;
  }

  /** The visible screen, or with `all` the kept scrollback above it too. */
  text(all = false): string[] {
    return this.lines.slice(all ? 0 : this.top()).map(cells => Array.from(cells, cell => cell ?? ' ').join('').trimEnd());
  }

  /** The cursor on the visible screen, counted from 1 as terminals report it. */
  cursor(): { row: number; col: number } {
    return { row: Math.min(this.rows, Math.max(1, this.row - this.top() + 1)), col: Math.min(this.cols, this.col + 1) };
  }

  /** The visible screen, or with `all` the kept scrollback too, with rows that wrapped at the width joined back into the lines they were printed as. */
  logicalText(all = false): string[] {
    const result: string[] = [], rows = this.lines.slice(all ? 0 : this.top());
    rows.forEach((cells, index) => {
      const text = Array.from(cells, cell => cell ?? ' ').join('');
      if (index && this.wrapped.has(rows[index - 1]!)) result[result.length - 1] += text; else result.push(text);
    });
    return result.map(line => line.trimEnd());
  }

  write(chunk: string): void {
    const output = this.pending + chunk;
    this.pending = '';
    for (let index = 0; index < output.length; index++) {
      const char = output[index]!;
      if (char === '\x1b') {
        const next = output[index + 1];
        if (next === undefined) { this.pending = output.slice(index); break; }
        if (next === '[') {
          const match = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(output.slice(index, index + 64));
          if (!match) {
            if (/^\x1b\[[0-?]*[ -/]*$/.test(output.slice(index, index + 64))) { this.pending = output.slice(index); break; }
            index++; continue;
          }
          index += match[0].length - 1;
          this.csi(match[1] ?? '', match[3]!);
          continue;
        }
        if (next === ']' || next === 'P' || next === '_' || next === '^') {
          // OSC/DCS/APC payloads run until BEL or ST.
          const bel = output.indexOf('\x07', index + 2), st = output.indexOf('\x1b\\', index + 2);
          const end = [bel, st].filter(value => value >= 0).sort((a, b) => a - b)[0];
          if (end === undefined) { if (output.length - index <= MAX_PENDING) this.pending = output.slice(index); break; }
          index = end === st ? st + 1 : bel;
          continue;
        }
        if (next === '7') this.saved = { row: this.row, col: this.col };
        else if (next === '8') ({ row: this.row, col: this.col } = this.saved);
        else if (next === 'M') this.row = Math.max(0, this.row - 1);
        else if (next === 'c') this.clear();
        else if (next === '(' || next === ')' || next === '#') { if (index + 2 >= output.length) { this.pending = output.slice(index); break; } index++; }
        index++;
        continue;
      }
      if (char === '\n') { this.row++; this.col = 0; this.line(); }
      else if (char === '\r') this.col = 0;
      else if (char === '\b') this.col = Math.max(0, this.col - 1);
      else if (char === '\t') this.col = Math.min(MAX_COLS, (Math.floor(this.col / 8) + 1) * 8);
      else if (char >= ' ' && char !== '\x7f' && !(char >= '\x80' && char <= '\x9f')) this.put(char);
    }
    this.trim();
  }

  private csi(raw: string, final: string): void {
    if (/^[<>=?]/.test(raw)) return;
    const params = raw.split(';').map(value => Math.min(MAX_COLS, Number.parseInt(value, 10))), n = Math.max(1, params[0] || 1), mode = params[0] || 0;
    if (final === 'A') this.row = Math.max(0, this.row - n);
    else if (final === 'B' || final === 'e') this.row = Math.max(this.row, Math.min(this.row + n, this.bottom()));
    else if (final === 'C' || final === 'a') this.col = Math.min(MAX_COLS, this.col + n);
    else if (final === 'D') this.col = Math.max(0, this.col - n);
    else if (final === 'E') { this.row = Math.max(this.row, Math.min(this.row + n, this.bottom())); this.col = 0; }
    else if (final === 'F') { this.row = Math.max(0, this.row - n); this.col = 0; }
    else if (final === 'G' || final === '`') this.col = n - 1;
    else if (final === 'd') this.row = this.top() + Math.min(n, this.rows) - 1;
    else if (final === 'H' || final === 'f') { this.row = this.top() + Math.min(n, this.rows) - 1; this.col = Math.max(1, params[1] || 1) - 1; }
    else if (final === 'K') { const cells = this.line(); if (mode !== 1) this.wrapped.delete(cells); if (mode === 0) cells.length = Math.min(cells.length, this.col); else if (mode === 1) cells.fill(' ', 0, Math.min(cells.length, this.col + 1)); else cells.length = 0; }
    else if (final === 'X') { const cells = this.line(); cells.fill(' ', this.col, Math.min(cells.length, this.col + n)); }
    else if (final === 'J') {
      if (mode === 0) { this.line().length = Math.min(this.line().length, this.col); this.lines.length = this.row + 1; }
      else if (mode === 1) { for (let r = 0; r < this.row; r++) this.lines[r] = []; this.line().fill(' ', 0, Math.min(this.line().length, this.col + 1)); }
      else this.clear();
    }
    else if (final === 's') this.saved = { row: this.row, col: this.col };
    else if (final === 'u') ({ row: this.row, col: this.col } = this.saved);
  }
  private line(): string[] { while (this.lines.length <= this.row) this.lines.push([]); return this.lines[this.row]!; }
  private top(): number { return Math.max(0, this.lines.length - this.rows); }
  // The cursor never leaves the visible screen: moving down stops at its last row, moving right at MAX_COLS.
  private bottom(): number { return this.top() + this.rows - 1; }
  private put(char: string): void {
    // A character past the last column wraps to the next row; ConPTY relies on this instead of writing line breaks. Without a
    // known width nothing wraps.
    if (this.col >= this.cols && this.cols < MAX_COLS) { this.wrapped.add(this.line()); this.row++; this.col = 0; }
    const cells = this.line(); while (cells.length < this.col) cells.push(' '); cells[this.col++] = char;
  }
  private clear(): void { this.lines = [[]]; this.row = 0; this.col = 0; }
  /** Long sessions keep only a bounded scrollback above the screen. */
  private trim(): void {
    const drop = this.lines.length - this.rows - this.scrollback;
    if (drop <= 0) return;
    this.lines.splice(0, drop);
    this.row = Math.max(0, this.row - drop);
    this.saved = { row: Math.max(0, this.saved.row - drop), col: this.saved.col };
  }
}

/** Renders a whole output at once: the kept scrollback and the screen below it. */
export function renderTerminalScreen(output: string, rows = 30, cols = MAX_COLS): string[] {
  const screen = new TerminalScreen(rows, Number.POSITIVE_INFINITY);
  screen.resize(cols, rows);
  screen.write(output);
  return screen.text(true);
}
