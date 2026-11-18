/** File logger in userData/logs with every line passed through the Redactor. */
import fs from 'node:fs';
import path from 'node:path';
import { type Logger, Redactor } from '../core/logger';

const MAX_BYTES = 1_000_000;

export class FileLogger implements Logger {
  readonly file: string;

  constructor(
    dir: string,
    readonly redactor: Redactor,
    private readonly echo = false,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'connector.log');
  }

  private write(level: string, msg: string, meta?: Record<string, unknown>): void {
    const line =
      JSON.stringify({
        t: new Date().toISOString(),
        level,
        msg: this.redactor.text(msg),
        ...(meta ? { meta: this.redactor.value(meta) } : {}),
      }) + '\n';
    try {
      const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      if (size + line.length > MAX_BYTES) fs.renameSync(this.file, `${this.file}.1`);
      fs.appendFileSync(this.file, line, { mode: 0o600 });
    } catch {
      // Logging never breaks the app.
    }
    if (this.echo) process.stdout.write(line);
  }

  debug(msg: string, meta?: Record<string, unknown>) {
    this.write('debug', msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>) {
    this.write('info', msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>) {
    this.write('warn', msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>) {
    this.write('error', msg, meta);
  }
}
