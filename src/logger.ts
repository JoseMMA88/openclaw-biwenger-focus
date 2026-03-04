export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  private readonly minPriority: number;

  constructor(level: LogLevel = 'info') {
    this.minPriority = LOG_PRIORITY[level] ?? LOG_PRIORITY.info;
  }

  debug(message: string, fields: Record<string, unknown> = {}): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    if (LOG_PRIORITY[level] < this.minPriority) return;

    const payload = {
      ts: new Date().toISOString(),
      level,
      message,
      ...fields
    };

    console.log(JSON.stringify(payload));
  }
}
