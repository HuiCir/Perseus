/** Parse complete action objects as the constrained JSON response streams.
 * No action is dispatched from an incomplete object, string, or argument.
 */
export class ActionStream {
  constructor(onAction) { this.onAction = onAction; this.buffer = ''; this.scan = 0; this.array = false; this.start = -1; this.depth = 0; this.string = false; this.escape = false; this.actions = []; }
  push(delta) {
    this.buffer += delta;
    if (this.ended) return;
    if (!this.array) {
      const match = /"actions"\s*:\s*\[/.exec(this.buffer);
      if (!match) return;
      this.array = true; this.scan = match.index + match[0].length;
    }
    while (this.scan < this.buffer.length) {
      const char = this.buffer[this.scan];
      if (this.string) {
        if (this.escape) this.escape = false;
        else if (char === '\\') this.escape = true;
        else if (char === '"') this.string = false;
      } else if (char === '"') this.string = true;
      else if (char === '{') { if (this.depth === 0) this.start = this.scan; this.depth++; }
      else if (char === '}') {
        this.depth--;
        if (this.depth < 0) throw new Error('Malformed streamed action object');
        if (this.depth === 0 && this.start >= 0) {
          const action = JSON.parse(this.buffer.slice(this.start, this.scan + 1));
          this.actions.push(action); this.onAction(action); this.start = -1;
        }
      } else if (char === ']' && this.depth === 0) { this.scan++; this.ended = true; break; }
      this.scan++;
    }
  }
  finish() {
    const value = JSON.parse(this.buffer);
    if (!value || !Array.isArray(value.actions) || Object.keys(value).length !== 1) throw new Error('Expected constrained actions response');
    if (JSON.stringify(value.actions) !== JSON.stringify(this.actions)) throw new Error('Streamed actions do not match final JSON');
    return value.actions;
  }
}
