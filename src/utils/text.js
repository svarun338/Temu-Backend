// Control characters except tab (\x09), newline (\x0A) and carriage return (\x0D).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Normalise free text from users: strip control characters, normalise newlines, trim. */
export function cleanText(value) {
  return String(value).replace(CONTROL_CHARS, '').replace(/\r\n?/g, '\n').trim();
}

/** Escape LIKE wildcards so user input is matched literally. */
export function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}
