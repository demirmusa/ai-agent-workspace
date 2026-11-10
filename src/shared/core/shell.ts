/** Quote one argument for a POSIX-compatible shell using single quotes. */
export function quotePosixShell(value: string): string {
  if (value.includes('\0')) throw new TypeError('POSIX shell arguments cannot contain NUL bytes.');
  if (value.length === 0) return "''";
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function joinPosixShellArgs(values: readonly string[]): string {
  return values.map(quotePosixShell).join(' ');
}
