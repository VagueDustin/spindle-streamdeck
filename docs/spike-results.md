# Hardware spike results (spec section 12)

Method: 2026-10-14, Stream Deck 7.x on Windows 11. Spike plugin drew a `bg` PNG (red-to-blue gradient, white 58x58 square) and a 10 fps `fg` SVG over it. Read from a full-resolution capture of the Stream Deck app's strip preview (the app renders the strip bitmap on the host and sends it to the device) plus Dustin's observation of the deck.

1. Alpha composite: PASS. The gradient shows through the transparent `fg` areas, and the 0.45 black rect visibly darkens the right half.
2. CJK and Hangul: PASS. `夜に駆ける` and `아이유` render with real glyphs in the app's strip renderer. At 400/13px from x=74, `夜に駆ける — YOASOBI` overflows the right edge and is clipped by the pixmap bounds.
3. Width of `Spindle Test Ag 0123` at 600/17px from x=0: 177 px (+/-3), measured against the ruler (preview scale 0.58 screen px per strip px; last glyph ends 102.5 screen px from x=0).
4. 10 fps: the counter advances smoothly with no stalls (Dustin), but the plugin log measured 91-92 frames per 10 s, a mean send interval of 109 ms, so about 9.2 fps against a 100 ms target. The spike used a plain `setInterval(100)` and did not await `setFeedback`; the stretch is likely per-tick synchronous work (SVG build, `encodeURIComponent`, WebSocket send) plus timer latency, not chained awaits. Task 11's loop must not let send latency stretch the tick (schedule against a monotonic clock, skip rather than queue).
5. Escaped `&` and `<`: PASS. They render literally.

Decision: `RENDER_MODE = "layered"`.
