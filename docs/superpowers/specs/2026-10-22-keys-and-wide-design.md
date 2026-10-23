# Keys and Wide: design

Date: 2026-10-22. Status: approved (sections 1 and 2 reviewed; the rest taken as recommended).

## Goal

Spindle today is one Stream Deck+ dial action. This adds:

1. **Key actions**, so an ordinary Stream Deck (or the keys on a +) can be a full player:
   - **Cover**: the now-playing cover on a key, with a display option; press = play/pause.
   - **Transport**: one action with a function dropdown (play/pause, next, previous, mute,
     volume up, volume down) whose icon shows live state.
2. **Now Playing (Wide)**: two adjacent dials act as one 400×100 widget for one player.

Existing profiles must keep working: the `com.vaguedustin.spindle.dial` action is unchanged in UUID,
settings and behaviour.

## 1. Architecture

```
HaConnection (shared) ── entity subscription per widget (bindDial, unchanged)
        │
   PlayerSession   one per widget (a dial, a wide pair, a key)
                   player + connection state, cover, optimistic volume/mute,
                   volume debounce + adopt guard, skip counting, service calls, alerts.
                   No rendering, no SDK, no timers.
        │
   Surface         draws a session for one kind of hardware
   ├─ DialController       200×100 bg/fg (today's dial; owns mode, takeover, marquee)
   ├─ WideController       400×100, sliced into two 200×100 halves
   ├─ CoverKeyController   144×144 SVG
   └─ TransportKeyController 144×144 SVG
        │
   FrameLoop       one per plugin; at most 10 sends/s across every surface.
                   A wide pair is one unit of cost 2: both halves go out in the same heartbeat,
                   and the loop then rests one heartbeat to pay for the second send.
```

- `SpindleHub` (new) owns what `SpindleDial` owned that every action needs: global settings, the
  shared connection, the cover loader, the frame loop, the PI status line and the media-player
  picker. Actions are thin: they map SDK events to their controllers.
- One session per widget, not per entity: a key and a dial on the same player run separate sessions.
  After a dial turn, the key catches up when HA reports back.
- The refactor of `DialController` into `PlayerSession` + the dial surface keeps the existing
  controller, loop and golden tests passing with no behaviour change.

## 2. Wide

**Pairing.** Wide dials are grouped by device, sorted by column and paired greedily from the left
(`pairWideDials`, a pure function). Three Wide dials give one pair and one unpaired dial. An unpaired
dial waits about 300 ms (pairs form as `willAppear` events trickle in), then shows
"Add a Wide dial next to this one"; its input alerts. A pair breaks when either half disappears.

**Settings.** The left half owns them: player, volume step, source labels. The right half's PI shows
only "Settings for this widget are on the left dial"; its own stored settings are ignored.

**Controls.**

| Input | Action |
|---|---|
| Left turn | Volume (same debounce and adopt guard as the dial) |
| Left press | Mute toggle (alert if the player can't mute) |
| Right turn | Skip tracks (4 detents per skip, same cooldown) |
| Right press | Play/pause |
| Tap either half | Play/pause |

**Layout (400×100).** Thumbnail at the left, title and artist across the full width, play state and
source label under them. Bottom row: the volume bar on the left half (above the volume dial), and
back / play-state / forward glyphs on the right half (above the skip dial). The volume takeover
covers the left half only; the skip flash is on the right half.

**Rendering.** The strip is one continuous panel, so the seam is a timing problem only. The bg is
built once per cover at 400×100 and cropped into two PNGs; the fg is one 400-wide SVG per frame, sent
to each half with a `viewBox` offset. Both halves are sent in the same heartbeat.

## 3. Keys

Keys are drawn as 144×144 SVG (`setImage` with an SVG data URI); the deck scales them for 72×72 keys.
They redraw only on state changes, except Cover's "art + title" when the title scrolls (half rate).

**Cover** (`com.vaguedustin.spindle.cover`, Keypad). Settings: player, display.
- *Art* (default): full-bleed cover; a small pause badge when paused, accent play bars when playing.
- *Art + title*: the cover with the title on a dark band along the bottom, scrolling when too long.
- *Text*: title and artist on an accent gradient, wrapped to fit.
- No cover: the accent gradient. Press: play/pause.

**Transport** (`com.vaguedustin.spindle.transport`, Keypad). Settings: player, function, volume step.
- Play/pause: shows ▶ unless playing, then ❚❚. Next / previous: chevrons.
- Mute: a speaker, red with a cross when muted. Press sends `volume_mute` with the toggled value.
- Volume up / down: a speaker with + or −, and the current volume underneath. Press steps the
  volume (debounced `volume_set`, or `volume_up`/`volume_down` for step-only players); holding
  repeats every 200 ms after 400 ms.
- A function the player doesn't support draws dimmed and alerts on press.

## 4. Errors and states

Every surface uses the session's view: setup needed, check token, connecting, reconnecting
(dimmed + badge on strips, dimmed on keys), player not found, unavailable, off. Keys show a short
word ("Set up", "Token", "…", "Not found", "Offline", "Off") because full sentences don't fit.
Refused input alerts (throttled to one per 500 ms) as today.

## 5. Testing

- Existing tests stay green unchanged apart from imports (`controller`, `loop`, `golden`, `binding`).
- New unit tests: `PlayerSession` (mute toggle, volume step/nudge, skip counting), `pairWideDials`,
  the loop's cost-2 units (atomic send, rest beat, priority), `WideController` controls and slicing,
  key controllers (press mapping, hold repeat, dimmed unsupported functions, display modes),
  manifest (four actions).
- Manual check on hardware: the Wide seam while the title scrolls and during a takeover; key
  legibility at 72×72.
