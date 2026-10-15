# Hardware spike results (spec section 12)

Method: 2026-10-14, Stream Deck 7.x on Windows 11, on the author's Stream Deck+. Spike plugin drew a `bg` PNG (red-to-blue gradient, white 58x58 square) and a 10 fps `fg` SVG over it. Read from a full-resolution capture of the Stream Deck app's strip preview (the app renders the strip bitmap on the host and sends it to the device) plus the operator's observation of the deck.

Layout used (for reproducibility): line 1 `Spindle Test Ag 0123` at x=0, y=18, 600/17px. Lines 2-4 (`夜に駆ける — YOASOBI`, `아이유 Love wins all`, `Ünïcødé & <xml>`) at x=74, y=38/56/74, 400/13px (moved from x=2 because they were hidden behind the white 58x58 square). The Hangul line is fully visible; the CJK line is clipped at the right edge.

1. Alpha composite: PASS. The gradient shows through the transparent `fg` areas, and the 0.45 black rect visibly darkens the right half.
2. CJK and Hangul: PASS. `夜に駆ける` and `아이유` render with real glyphs in the app's strip renderer. At 400/13px from x=74, `夜に駆ける — YOASOBI` overflows the right edge and is clipped by the pixmap bounds.
3. Width of `Spindle Test Ag 0123` at 600/17px from x=0.
   - First reading: 177 px (+/-3), measured against the ruler (preview scale 0.58 screen px per strip px; last glyph ends 102.5 screen px from x=0). This used the spec's quoted comma-separated `font-family` list. Stream Deck's SVG renderer treats the whole attribute as one family name, so the list fell back to the app default, Tahoma Bold. Glyph positions match: T 69.0 / A 110.3 / 0 136.2 / end 177.6 measured vs Tahoma Bold advances 68.4 / 109.7 / 137.0 / 180.3.
   - Corrected measurement: `font-family="Segoe UI"` (single, unquoted) renders real Segoe UI. At 600/17px it ends at 159 px (+/-3). Weights 400/600/700 are distinct, with ink ends of about 155/159/166 px. CJK, Hangul and Han still fall back to real glyphs, and escaping is fine.
   - Decision: use the single family `Segoe UI` (`FONT_STACK` in `src/render/geometry.ts`). macOS falls back to the system default font (unverified until a Mac test).
4. 10 fps smoothness: PASS. The counter advanced smoothly with no lag or stalls. The plugin log measured 91-92 frames per 10 s (mean interval 109 ms, about 9.2 fps against a 100 ms target); this is timer/tick drift in the spike (plain `setInterval(100)`, un-awaited `setFeedback`, per-tick synchronous work), not device back-pressure.
5. Escaped `&` and `<`: PASS. They render literally.

Decision: `RENDER_MODE = "layered"`.

Task 11 budget: keep 10 fps / 100 ms per frame, and schedule ticks against a monotonic clock so drift does not accumulate (skip frames rather than queue them).
