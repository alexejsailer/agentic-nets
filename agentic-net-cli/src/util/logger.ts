/**
 * Minimal diagnostic logger. Writes to STDERR only — stdout is reserved for
 * user-facing command output (render/output.ts), so piped/JSON output stays clean.
 *
 * Line format matches the Java services' logback pattern so aggregated logs
 * look uniform: `YYYY-MM-DD HH:mm:ss.SSS LEVEL message` (LEVEL padded to 5).
 * Extra args are appended exactly like console.log would.
 */
function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function write(level: string, args: unknown[]): void {
  console.error(`${timestamp()} ${level.padEnd(5)}`, ...args);
}

export const log = {
  debug: (...args: unknown[]): void => write('DEBUG', args),
  info: (...args: unknown[]): void => write('INFO', args),
  warn: (...args: unknown[]): void => write('WARN', args),
  error: (...args: unknown[]): void => write('ERROR', args),
};
