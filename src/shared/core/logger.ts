import chalk from 'chalk';

export interface Logger {
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  detail(message: string): void;
}

export class ConsoleLogger implements Logger {
  constructor(private readonly verbose = false) {}

  info(message: string): void {
    process.stdout.write(`${message}\n`);
  }

  success(message: string): void {
    process.stdout.write(`${chalk.green('✓')} ${message}\n`);
  }

  warn(message: string): void {
    process.stderr.write(`${chalk.yellow('!')} ${message}\n`);
  }

  error(message: string): void {
    process.stderr.write(`${chalk.red('✗')} ${message}\n`);
  }

  detail(message: string): void {
    if (this.verbose) process.stdout.write(`${chalk.dim(message)}\n`);
  }
}

export class AiwsError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'AiwsError';
  }
}

