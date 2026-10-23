# Changelog

## 1.1.0

Spindle grows from one dial action to four.

- **Now Playing (Wide):** put it on two neighbouring dials and they show one player across both strips. The left dial sets the volume (press to mute), the right dial skips tracks (press to play or pause). Tap the left or right end of the widget to skip back or forward, and the middle to play or pause. Both halves update together, so nothing tears at the seam.
- **Tap zones** on the Now Playing dial too, as an opt-in setting: tap the strip's left or right edge to skip tracks. Off by default, so a tap anywhere still plays or pauses.
- **Cover** key: the now-playing cover on any Stream Deck key, as art with a play-state badge, art only, art with the title, or title and artist on the accent colour. Press to play or pause.
- **Transport** key: play/pause, next, previous, mute, volume up or volume down, with an icon that follows the player (pause bars while playing, a red speaker while muted, the volume under the volume keys). Hold a volume key to keep stepping.
- All actions share one Home Assistant connection and one 10 updates per second budget. Existing Now Playing dials are unchanged.

## 1.0.0

The first release of Spindle: Now Playing for Home Assistant on Stream Deck+.

- A Stream Deck+ dial action that shows any Home Assistant `media_player` on the touch strip: a blurred cover backdrop, a sharp thumbnail, scrolling title and artist, play bars, a source label and a volume bar.
- An accent colour picked from each cover, pixel by pixel, with an accent gradient and placeholder thumbnail when there is no art.
- Volume mode: turn to set the volume with an instant full-strip readout; one `volume_set` call 150 ms after the last click. Players that only step the volume get one `volume_up` or `volume_down` per click.
- Tracks mode: press to switch, then every 4 clicks skips a track. It switches back to volume mode after 6 seconds idle.
- Tap the strip to play or pause.
- Property inspector with the Home Assistant URL, access token, a live connection status line, a media-player picker, volume step, source labels and a tracks-mode switch.
- One shared WebSocket per Home Assistant server, with heartbeat and backoff. No reconnect after a rejected token, so it never adds up failed logins.
- Clear strip messages for setup, connecting, reconnecting, a rejected token, a missing player and an unavailable player.
- At most 10 strip updates per second across all dials, and no updates at all while nothing moves.
- Windows and macOS. Requires Stream Deck 7.1 or newer and supports Home Assistant 2025.10 and newer.
