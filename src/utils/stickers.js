/**
 * Built-in stickers, drawn by the app (no image files): "blob:<name>" from the
 * TEMU blob pack, or "emoji:<one emoji>" shown big. Must match the client's list.
 */
export const BLOB_STICKERS = [
  'hi', 'love', 'laugh', 'wow', 'sad', 'cry', 'angry', 'cool',
  'party', 'thanks', 'sleepy', 'thinking', 'ok', 'no', 'hug', 'shy',
];

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)/u;

export function isBuiltinSticker(value) {
  if (typeof value !== 'string' || value.length > 40) return false;
  if (value.startsWith('blob:')) return BLOB_STICKERS.includes(value.slice(5));
  if (value.startsWith('emoji:')) {
    const emoji = value.slice(6);
    return [...graphemes.segment(emoji)].length === 1 && EMOJI.test(emoji);
  }
  return false;
}
