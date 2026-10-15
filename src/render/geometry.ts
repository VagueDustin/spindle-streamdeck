/** Width of the Stream Deck+ touch strip segment for one dial, in pixels. */
export const STRIP_W = 200;
/** Height of the touch strip, in pixels. */
export const STRIP_H = 100;
/**
 * Font family for all SVG text. Spec 4.2 lists this stack:
 *   "Segoe UI","Yu Gothic UI","Meiryo","Malgun Gothic","Microsoft YaHei","SF Pro Text","Hiragino Sans","PingFang SC",sans-serif
 * Stream Deck's SVG renderer treats the whole font-family attribute as ONE family name, so a
 * list silently falls back to the app default (Tahoma). A single unquoted family renders real
 * Segoe UI, and CJK and Hangul still fall back to real glyphs. See docs/spike-results.md item 3.
 */
export const FONT_STACK = "Segoe UI";
/** Custom layout file, relative to the plugin folder. */
export const LAYOUT_PATH = "layouts/spindle.json";
