/** Image formats a browser shows in an <img>, by lower-case file extension (with the dot). SVG is listed for serving; it is text, so editors open it as text. */
export const IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif',
};
