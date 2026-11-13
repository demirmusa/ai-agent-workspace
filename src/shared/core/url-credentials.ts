/**
 * Hides user names and passwords embedded in URLs (`https://x-access-token:TOKEN@github.com/...`), which Git and other
 * CLIs may repeat in their error output, before that text reaches errors, logs or events.
 */
export function redactUrlCredentials(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, '$1***@');
}
