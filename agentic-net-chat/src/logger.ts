/**
 * Minimal service logger for the long-running chat bridge.
 * info/debug go to stdout, warn/error to stderr — Docker captures both.
 *
 * Line format matches the Java services' logback pattern so aggregated logs
 * look uniform: `YYYY-MM-DD HH:mm:ss.SSS LEVEL message` (LEVEL padded to 5).
 * Extra args are appended exactly like console.log would.
 */
function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function write(target: (...data: unknown[]) => void, level: string, args: unknown[]): void {
  target(`${timestamp()} ${level.padEnd(5)}`, ...args);
}

export const log = {
  debug: (...args: unknown[]): void => write(console.log, 'DEBUG', args),
  info: (...args: unknown[]): void => write(console.log, 'INFO', args),
  warn: (...args: unknown[]): void => write(console.error, 'WARN', args),
  error: (...args: unknown[]): void => write(console.error, 'ERROR', args),
};
