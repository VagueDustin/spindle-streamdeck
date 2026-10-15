# Changelog

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
