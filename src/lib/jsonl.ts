/**
 * An append-only JSONL file that must never take its caller down with it.
 *
 * The audit log and the trace both wrote their own copy of this: make the
 * directory, roll the file if it has grown too big, append one line, and on any
 * failure latch a `_broken` flag so a log that cannot be written stops trying
 * rather than throwing on every call for the rest of the session. Ten lines,
 * twice, guarding the same promise.
 *
 * The promise is the point and it is worth having in one place. Both files are
 * bookkeeping: the audit log is evidence and the trace is diagnostics, and
 * neither is the agent's task. A full disk must cost the record, never the
 * work.
 */
import fs from 'node:fs';
import path from 'node:path';

import { rotateSync } from './rotate.ts';

export class JsonlFile {
  private readonly _path: string;
  private _broken = false;

  constructor(file: string) {
    this._path = file;
  }

  get path(): string {
    return this._path;
  }

  /** True once a write has failed; nothing is attempted after that. */
  get broken(): boolean {
    return this._broken;
  }

  /**
   * Appends one already-serialised line. Returns false if it was not written,
   * so a caller that cares can tell — none currently does, which is the design.
   */
  append(line: string): boolean {
    if (this._broken)
      return false;
    try {
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      // Rolled rather than trimmed: nothing is ever removed from the middle of
      // an account of what happened.
      rotateSync(this._path);
      fs.appendFileSync(this._path, `${line}\n`, 'utf8');
      return true;
    } catch {
      this._broken = true;
      return false;
    }
  }
}
