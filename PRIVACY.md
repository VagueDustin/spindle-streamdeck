# Privacy policy

Spindle is a Stream Deck plugin that shows what a Home Assistant media player is playing. This page explains what it does with your data. In short: it collects nothing, and talks only to your own Home Assistant.

## What Spindle connects to

- **The Home Assistant URL you enter.** Spindle opens a WebSocket to it to read your media players' states and to send the commands you give with the dial. It also fetches cover art that Home Assistant serves itself, using your token.
- **External cover-art URLs that Home Assistant points to.** Some integrations give a cover image on another host. Spindle fetches those directly, **without** your token.

Spindle makes no other network connections.

## What Spindle stores

- **Your Home Assistant URL and access token** are kept in the Stream Deck app's global plugin settings on this computer. Stream Deck has no secret storage for plugins, so they are stored in plain text. They aren't included when you export a Stream Deck profile.
- **Per-dial settings** (the media player, volume step, source labels and tracks mode) are kept in the Stream Deck app's settings for that dial.
- **Cover art** is held in memory only (the last three covers) and is never written to disk.
- **Logs** are written by the Stream Deck app to the plugin's `logs` folder on this computer. The token is never written to them.

To remove everything, delete the dials and uninstall Spindle in the Stream Deck app, then revoke the token in Home Assistant under **Profile → Security → Long-lived access tokens**.

## What Spindle does not do

- No telemetry, no analytics, no crash reporting and no tracking of any kind.
- It never sends your token anywhere except to your Home Assistant.
- It never sends your data to the author or to any third party.

## What Spindle can do in Home Assistant

With your token, Spindle reads entity states and calls only these `media_player` services: `volume_set`, `volume_up`, `volume_down`, `media_play_pause`, `media_next_track` and `media_previous_track`. A token from a dedicated non-admin user is enough, and is recommended.

## Questions

Open an issue at <https://github.com/VagueDustin/spindle-streamdeck/issues>.
