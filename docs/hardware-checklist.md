# Spindle hardware acceptance checklist

Run this on a real Stream Deck+ before every Marketplace submission, once against the dev build and once against the DRM build downloaded from Maker Console (section 9). Tick a box only when the check passes. On a failure, leave the box empty, write `FAIL` in the **Result** field and describe what happened in **Notes**. Every failure becomes its own fix commit with a regression test.

Use a spare profile page, so the checks don't disturb a working layout. Spindle has its own plugin id, so any other plugin can stay installed alongside it. Use a test Home Assistant, or a normal one with a spare player. Never use a token with more rights than a non-admin user needs.

## Run details

| Field | Value |
|---|---|
| Date | |
| Tester | |
| Build under test | dev build / DRM build (circle one) |
| Plugin version | |
| Stream Deck app version | |
| OS and version | |
| Home Assistant version | |
| Players used (fictional names in the notes, please) | |

Result key for every item: `PASS`, `FAIL`, or `N/A` (with the reason in Notes).

## 1. First-run setup

- [ ] **1.1 Install and drag.** Spindle appears in the action list under the **Spindle** category with the **Now Playing** action and its icon (white glyph, no background). Dragging it onto a dial works.
  Result: ____ Notes: ____
- [ ] **1.2 Empty property inspector.** The inspector opens, shows an empty URL and token, and the status line reads "Enter your Home Assistant URL and token".
  Result: ____ Notes: ____
- [ ] **1.3 Connect.** Pasting the URL and the token changes the status to "Connecting…" and then "Connected · HA *version* · *n* media players". There is no Save button, and the settings are still there after the inspector is closed and reopened.
  Result: ____ Notes: ____
- [ ] **1.4 Token field.** The token field hides its contents, and the help link opens the README's **Create a token** section in the default browser.
  Result: ____ Notes: ____
- [ ] **1.5 Media player list.** The list shows only `media_player.*` entities, with friendly names and the entity id as secondary text. The refresh button re-reads the list.
  Result: ____ Notes: ____
- [ ] **1.6 Volume step, source labels, tracks mode.** The volume step (1 to 10, default 2), the source-labels box and the tracks-mode checkbox (on by default) each save on change, with no Save button.
  Result: ____ Notes: ____
- [ ] **1.7 Shared settings.** A second dial shows the same URL and token without entering them again, and has its own player, step, labels and tracks setting.
  Result: ____ Notes: ____

## 2. Dial controls (spec section 6)

### Volume mode (the default)

- [ ] **2.1 Rotate changes the volume.** Each click changes the volume by the volume step, the dial updates at once (before Home Assistant answers), and the takeover opens.
  Result: ____ Notes: ____
- [ ] **2.2 Clamping.** Turning down past 0 and up past 100 stops at 0 and 100. The number never goes outside that range.
  Result: ____ Notes: ____
- [ ] **2.3 One call per burst.** A fast spin sends a single `volume_set` about 150 ms after the last click, not one per click (check the Home Assistant logbook or the developer tools' events view). The player ends on the volume shown on the strip.
  Result: ____ Notes: ____
- [ ] **2.4 Adopt guard.** For about 2.5 s after turning, stray intermediate volume reports from the player don't make the number jump back. After that, a change made on the player itself (its own remote or app) shows up on the strip.
  Result: ____ Notes: ____
- [ ] **2.5 Unmute on turn up.** With the player muted (the strip shows MUTE in red), turning up unmutes it.
  Result: ____ Notes: ____
- [ ] **2.6 Mute display.** Muting from Home Assistant shows a red MUTE in place of the number and a greyed volume bar.
  Result: ____ Notes: ____
- [ ] **2.7 Step-only player.** On a player that supports volume up and down but not a volume level, each click sends one step and the readout shows a bar with no number.
  Result: ____ Notes: ____
- [ ] **2.8 No volume control.** On a player with no volume control, turning does nothing in volume mode, the volume row is hidden, and the dial starts in tracks mode (when tracks mode is on).
  Result: ____ Notes: ____

### Tracks mode

- [ ] **2.9 Press enters tracks mode.** Pressing the dial in volume mode replaces the volume row with the back and forward chevrons and a centre dot.
  Result: ____ Notes: ____
- [ ] **2.10 Four clicks skip.** Turning four clicks clockwise skips to the next track, and four anticlockwise skips back. The side that fired flashes in the accent colour for about 350 ms.
  Result: ____ Notes: ____
- [ ] **2.11 Cooldown.** After a skip, clicks within about 600 ms are ignored, so a fast spin skips one track at a time and not several.
  Result: ____ Notes: ____
- [ ] **2.12 Press returns to volume mode.** Pressing again in tracks mode switches back to volume mode, if the player has volume control.
  Result: ____ Notes: ____
- [ ] **2.13 Auto-revert.** After 6 s with no input, the dial returns to volume mode on its own.
  Result: ____ Notes: ____
- [ ] **2.14 Tracks mode unavailable.** With tracks mode switched off in the settings, or on a player that can't skip, pressing the dial does nothing. A player with no volume control stays in tracks mode.
  Result: ____ Notes: ____

### Touch

- [ ] **2.15 Tap plays and pauses.** Tapping the strip toggles play and pause, in volume mode and in tracks mode. The play bars and the pause glyph follow.
  Result: ____ Notes: ____
- [ ] **2.16 Tap when off.** With the player off, a tap still sends play/pause (whether the player wakes depends on its integration), and turning is ignored.
  Result: ____ Notes: ____
- [ ] **2.17 Trigger descriptions.** The dial's settings in the Stream Deck app list Rotate "Volume / Skip", Push "Switch mode" and Touch "Play/Pause".
  Result: ____ Notes: ____

## 3. States and errors (spec section 7)

For each row, check the strip and check that input behaves as the last column says.

- [ ] **3.1 Not configured** (no URL, token or entity). Strip: "Set up Spindle in Stream Deck". Input is ignored and the dial shows an alert.
  Result: ____ Notes: ____
- [ ] **3.2 HA unreachable or reconnecting** (stop Home Assistant, or disconnect the network). Strip: the last frame dimmed with a "Reconnecting…" badge. Input is ignored with an alert. It recovers by itself when Home Assistant is back.
  Result: ____ Notes: ____
- [ ] **3.3 Token rejected** (paste a wrong token). Strip: "Check token". Input is ignored with an alert. The inspector status says "Token rejected". Spindle does not reconnect until the URL or token changes.
  Result: ____ Notes: ____
- [ ] **3.4 Entity missing** (delete or rename the entity in Home Assistant). Strip: "Player not found" and the entity id. Input is ignored with an alert. The player list shows `(not found) media_player.…`.
  Result: ____ Notes: ____
- [ ] **3.5 Unavailable or unknown** (take the device offline). Strip: the last frame dimmed with "Unavailable". Input is ignored with an alert.
  Result: ____ Notes: ____
- [ ] **3.6 Off.** Strip: an accent gradient with the friendly name and "Off". Touch sends play/pause, and turning is ignored.
  Result: ____ Notes: ____
- [ ] **3.7 Idle, on or standby with no title.** Strip: the friendly name and "Idle". Input works normally.
  Result: ____ Notes: ____
- [ ] **3.8 Buffering.** Normal view with the play bars pulsing at half height. Input works normally.
  Result: ____ Notes: ____
- [ ] **3.9 Art fetch or decode fails, or the format is unsupported** (a player that serves WebP). The previous backdrop stays. On a new track, the strip shows the accent gradient and a placeholder thumbnail. Input works normally.
  Result: ____ Notes: ____
- [ ] **3.10 Service-call error.** A failed command (for example, a volume change on a player that rejects it) shows an alert on that dial.
  Result: ____ Notes: ____

## 4. Display checks

- [ ] **4.1 Rest view.** Blurred backdrop, sharp thumbnail, title, artist, play bars in the accent colour, the source label and the volume row, all inside the strip with nothing cut off.
  Result: ____ Notes: ____
- [ ] **4.2 Scrolling text, clipped by masks.** A title and an artist too long to fit scroll smoothly. They are clipped at x=74 on the left and x=194 on the right, with **no black box** behind or around the text, and nothing spills over the thumbnail.
  Result: ____ Notes: ____
- [ ] **4.3 Text that fits doesn't scroll.** A short title and artist stay still, and the strip sends no frames while nothing moves.
  Result: ____ Notes: ____
- [ ] **4.4 Takeover plate.** Turning the dial shows the full-strip takeover with a **blurred cover and no ghost thumbnail** showing through, the VOLUME label, the big number and the wide bar with its knob.
  Result: ____ Notes: ____
- [ ] **4.5 Takeover timing and fade.** The takeover holds for about 1.5 s after the last click, then **fades out smoothly** over about 300 ms, with no flash and no step.
  Result: ____ Notes: ____
- [ ] **4.6 No Tahoma.** No text on the strip is drawn in Tahoma. The font-family must stay a single family (`Segoe UI`). Check the title, the artist, the source label, the volume number, the takeover text and the status messages.
  Result: ____ Notes: ____
- [ ] **4.7 CJK title.** A track with a Japanese, Chinese or Korean title and artist renders real glyphs (no boxes), scrolls if too wide, and is clipped as in 4.2.
  Result: ____ Notes: ____
- [ ] **4.8 WebP-art player.** A player that serves WebP cover art shows the accent gradient and the placeholder thumbnail, with no error and no crash. Everything else on the dial still works.
  Result: ____ Notes: ____
- [ ] **4.9 Accent colour.** For a red-and-black cover, the accent is red, not neon pink. For a grey or black-and-white cover, the accent is a light grey.
  Result: ____ Notes: ____
- [ ] **4.10 Backdrop on track change.** On a track change, the backdrop and thumbnail swap to the new cover without a visible flash of the old one.
  Result: ____ Notes: ____

## 5. Several dials

- [ ] **5.1 Two dials, two entities.** Two dials pointed at two different players each show their own player. Turning one doesn't change the other. They run on one shared connection (one connection in the Home Assistant log, not two).
  Result: ____ Notes: ____
- [ ] **5.2 Two dials, one entity.** Two dials pointed at the same player stay in step. Changing the volume on one is reflected on the other once the adopt guard (about 2.5 s) has passed, and neither jumps back.
  Result: ____ Notes: ____
- [ ] **5.3 Frame budget with scrolling dials.** With two dials both scrolling long titles, both animate without stalls, at roughly 5 fps each, which is the 10-per-second share between two dials.
  Result: ____ Notes: ____

## 6. Long runs and recovery

- [ ] **6.1 No backdrop flicker on a proxied cover.** Leave one track playing for 5 minutes or more on a player whose cover art comes through Home Assistant's media proxy (Home Assistant rotates the proxy token). The backdrop never flickers or drops to the gradient during that time.
  Result: ____ Notes: ____
- [ ] **6.2 Memory over 30 minutes.** Play music for 30 minutes with the strip animating. In Task Manager, note the Stream Deck node process (the one running the plugin) at the start and the end. The memory climbs by no more than a few megabytes and settles.
  Start: ____ MB. After 10 min: ____ MB. After 30 min: ____ MB. Result: ____ Notes: ____
- [ ] **6.3 Home Assistant restarts mid-play.** Restart Home Assistant while a track plays. The strip dims and shows "Reconnecting…", and it recovers by itself with the right player state, without touching the Stream Deck app. Input works again once it recovers.
  Result: ____ Notes: ____
- [ ] **6.4 Network drop and return.** Disconnect and reconnect the network for about a minute. The same recovery happens, with retries 1 to 30 seconds apart.
  Result: ____ Notes: ____
- [ ] **6.5 Stream Deck app restart.** Quit and reopen the Stream Deck app. The dials come back with the right state, without re-entering the URL or token.
  Result: ____ Notes: ____

## 7. Token handling

- [ ] **7.1 Wrong token.** Paste a wrong token. The inspector status says **Token rejected**, and the strip says "Check token".
  Result: ____ Notes: ____
- [ ] **7.2 No repeated login failures.** After 7.1, wait two minutes. Home Assistant's log shows **one** failed login for that token and no more (and no other repeats from this computer's address). Fixing the token recovers on its own.
  Result: ____ Notes: ____
- [ ] **7.3 Token never in the logs.** Search the plugin's `logs` folder for part of the real token. There is no match.
  Result: ____ Notes: ____

## 8. Privacy and security spot checks

- [ ] **8.1 Settings.** Exporting a Stream Deck profile with Spindle on it doesn't include the URL or the token.
  Result: ____ Notes: ____
- [ ] **8.2 Connections.** While running, Spindle connects only to the Home Assistant host and to cover-art hosts that Home Assistant points to (check with a firewall log or a network monitor).
  Result: ____ Notes: ____

## 9. DRM build re-run (spec section 11)

Download the DRM-protected build from Maker Console: open the product, choose the **Versions** tab, select the version, and download. The upload must have "Publish after review" unticked.

- [ ] **9.1 Install the DRM build** over (or instead of) the dev copy, with the dev copy unlinked so only one Spindle is loaded. Record the build below.
  Result: ____ Notes: ____
- [ ] **9.2 Re-run sections 1 to 8** against the DRM build. Every item must pass again. Tick them in a fresh copy of this file (or write the DRM result next to each one) so the two runs stay separate.
  Result: ____ Notes: ____
- [ ] **9.3 DRM-specific checks.** The plugin loads and connects, the property inspector opens, the layout loads, the logs show no file-integrity or manifest-read errors, and the plugin survives a Stream Deck app restart.
  Result: ____ Notes: ____
- [ ] **9.4 Memory re-check.** Repeat the 30-minute memory run (6.2) on the DRM build.
  Result: ____ Notes: ____

DRM build version: ____ Downloaded on: ____

## 10. macOS (needs a Mac tester)

Run sections 1 to 8 on a Mac with Stream Deck 7.1 or newer, on the dev build first and then the DRM build.

| Field | Value |
|---|---|
| Tester | |
| macOS version | |
| Mac model and chip | |
| Stream Deck app version | |

- [ ] **10.1 Install and connect.** Install, add the plugin to a dial, connect, and pick a player.
  Result: ____ Notes: ____
- [ ] **10.2 Sections 1 to 8 all pass.** Record any differences below.
  Result: ____ Notes: ____
- [ ] **10.3 Strip font.** Segoe UI isn't installed on macOS, so the app should fall back to its default font. Check that the text still fits the strip, the scrolling triggers when it should and not otherwise, and that nothing is clipped or overlaps the thumbnail. Note the font that appears.
  Font seen: ____ Result: ____ Notes: ____
- [ ] **10.4 CJK on macOS.** The Japanese, Chinese and Korean test titles render real glyphs.
  Result: ____ Notes: ____
- [ ] **10.5 Memory.** The 30-minute run (6.2) stays flat on the Mac's Activity Monitor.
  Result: ____ Notes: ____
- [ ] **10.6 DRM build on macOS.** Section 9 passes on the Mac.
  Result: ____ Notes: ____

## Sign-off

| | Dev build, Windows | DRM build, Windows | Dev build, macOS | DRM build, macOS |
|---|---|---|---|---|
| All items pass | | | | |
| Failures found (commit ids of the fixes) | | | | |
| Signed off by, date | | | | |
