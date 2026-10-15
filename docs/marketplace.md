# Elgato Marketplace submission sheet

Everything to paste into Maker Console for Spindle 1.0.0, plus the steps around it. Work through the checklist at the bottom in order. The requirements below were read from the Elgato docs on 2026-10-15, and Elgato changes them, so tick "check today" before submitting.

## Listing

| Field | Value |
|---|---|
| Name | Spindle |
| Subtitle | Now Playing for Home Assistant |
| Category | Music / Audio |
| Price | Free |
| Product type | Stream Deck plugin |
| Author (as in the manifest) | VagueDustin. The plugin guidelines ask for the Marketplace organization name, so make the Maker Console organization match, or change the manifest `Author` to match it before packing. |
| Plugin UUID | `com.vaguedustin.spindle` (permanent once published; the action UUID is `com.vaguedustin.spindle.dial`) |
| Supported devices | Stream Deck+ (dials and touch strip) |
| Supported systems | Windows 10 and later, macOS 12 and later (macOS only once a Mac tester has passed section 10 of the hardware checklist; otherwise list Windows only) |
| Stream Deck app | 7.1 or newer |
| Support URL | https://github.com/VagueDustin/spindle-streamdeck/issues |
| Privacy URL | https://github.com/VagueDustin/spindle-streamdeck/blob/main/PRIVACY.md |
| Website / source link (optional) | https://github.com/VagueDustin/spindle-streamdeck |

Keywords to work into the description (Elgato asks for the supported software and devices to be named): Stream Deck+, Home Assistant, media player, now playing, album art, volume dial, touch strip.

## Description

About 940 characters (Elgato's email-route limit is 1,500, and the Maker Console form states none). It matches the README.

```text
Spindle turns a Stream Deck+ dial into a live "now playing" display for any Home Assistant media player. The touch strip shows the cover art over a blurred backdrop, the title and artist (scrolling only when they don't fit, with real Japanese, Chinese and Korean glyphs), play bars and the volume. Turn the dial to set the volume with an instant on-strip readout, press it to switch to tracks mode and skip tracks, and tap the strip to play or pause. Nothing needs to change on the Home Assistant side: paste your Home Assistant URL and a long-lived access token, pick a media player, and you're done. Several dials can show different players over one shared connection. Spindle has no telemetry and talks only to your own Home Assistant. A dedicated non-admin Home Assistant user is recommended for the token. Requires a Stream Deck+, Stream Deck 7.1 or newer, and Home Assistant 2025.10 or newer. Not affiliated with Home Assistant or Elgato.
```

Rules for this text: English only, no Home Assistant logo or branding, no claims the README doesn't back. If the description changes, change the README to match.

## Release notes (1.0.0)

Paste the 1.0.0 section of `CHANGELOG.md`.

## Images

Elgato's current rules (from docs.elgato.com/maker-console/submitting-products, read 2026-10-15; check today, see the checklist):

- **Thumbnail:** PNG, 1920 x 960 px (2:1).
- **Gallery:** at least 3 items, up to 10. Each is a PNG at 1920 x 960 px, or an MP4 video at 1920 x 1080 px (50 MB at most, with a 1920 x 960 thumbnail).
- **Plugin icon:** PNG, 256 x 256 px and 512 x 512 px (`imgs/plugin/marketplace.png` and `marketplace@2x.png`).
- Images must show the real product and must be ones you own. Text in them must be English.

The files in `docs/images/` are 600 x 300 px (the strip at 3x, also a 2:1 ratio), so they are **not** the right size to upload as they are. Compose each one onto a 1920 x 960 canvas (a dark background with the strip render centred and scaled, or a close crop of the hardware photo) rather than stretching the small image. A render at 3x is already soft, so keep the scale-up modest and put it on a plain background.

| File | What it shows | Use |
|---|---|---|
| `docs/images/hero.png` | Rest view, the README hero (the same frame as `rest.png`) | Thumbnail candidate. The owner's hardware photo (`docs/images/hero.jpg`, EXIF stripped), once added, is the better thumbnail. |
| `docs/images/rest.png` | Rest view, title scrolling, the Streaming source label | Gallery 1 |
| `docs/images/takeover.png` | Volume takeover over a blurred cover | Gallery 2 |
| `docs/images/tracks.png` | Tracks mode, forward chevrons flashing | Gallery 3 |
| `docs/images/paused.png` | Paused, pause glyph in place of the play bars | Gallery 4 (optional) |
| `docs/images/cjk.png` | A Chinese title with real glyphs | Gallery 5 (optional) |
| `docs/images/no-art.png` | No cover art: gradient and placeholder | Gallery 6 (optional) |
| `docs/images/spindle.gif` | The title scrolling, then a volume takeover that fades back | Source for an MP4 (1920 x 1080) if a video is wanted; the Marketplace takes MP4, not GIF |

Elgato also says products that need hardware or paid-service integrations must include a demo video showing the plugin fully working. Spindle needs a Stream Deck+ and a Home Assistant server, so plan a short MP4 of the real deck (1920 x 1080, 50 MB or less) with a 1920 x 960 thumbnail. Check today whether it is mandatory for this plugin.

No Home Assistant logo, Elgato logo or other third-party branding goes in any image (spec section 13, item 6).

## Check today's Marketplace requirements

- [ ] Open the Maker Console docs and re-read the pages below. Compare each number with this sheet, and update this file if anything changed.
  - Maker Console docs: https://docs.elgato.com/maker-console/ (start at **Submitting Products**: https://docs.elgato.com/maker-console/submitting-products/)
  - Review process: https://docs.elgato.com/maker-console/review-process/ (4 to 10 working days when read)
  - Plugin guidelines: https://docs.elgato.com/guidelines/stream-deck/plugins/
  - Product guidelines: https://docs.elgato.com/guidelines/products/
  - Distribution and DRM: https://docs.elgato.com/streamdeck/sdk/introduction/distribution/
  - Maker Console sign-in: https://maker.elgato.com/signin
  - (`https://docs.elgato.com/makers` returned 404 when tried on 2026-10-15; use the links above, or search the docs site for "Maker Console".)
- [ ] Image sizes still 1920 x 960 PNG (thumbnail and gallery), 3 gallery items minimum, MP4 at 1920 x 1080 for video. Plugin icon still 256 and 512 px.
- [ ] Description length limit and release-notes field, as the form shows them.
- [ ] Demo-video requirement for hardware plugins, as the form shows it.
- [ ] Category list: Music / Audio is still offered. If it isn't, pick the nearest one and record it here.
- [ ] Guidelines that may affect Spindle, as read on 2026-10-15 (decide each one before submitting):
  - The plugin guidelines ask for **between 2 and 30 actions**. Spindle has one action (**Now Playing**). Check whether review enforces this, and have a reply ready: Spindle's single action carries all its settings, and the guidelines also say to consolidate actions that share settings.
  - The guidelines give the **category icon as 28 x 28 px (56 x 56 at high DPI)**, and the action icon as 20 x 20 (40 at high DPI). `scripts/build-icons.ts` currently writes the category icon at 20 and 40 px, so check this against the manifest validation and the guideline before submitting.
  - Category and action icons must be monochrome white (`#FFFFFF`) on a transparent background, with no colour and no solid background.
  - The category should be similar to the plugin name (it is "Spindle"), and action names should be about 30 characters or fewer ("Now Playing").
- [ ] **UUID and name** (spec section 13, item 5): search the Marketplace for "Spindle" before locking the UUID in with the first submission. If another plugin has that name or a close one, stop and decide on a new name before anything is uploaded. The UUID `com.vaguedustin.spindle` can't change once it is published.
- [ ] **No Home Assistant logo** (spec section 13, item 6): no HA logo, mark or branding in the plugin icon, the preview images, the video or the description. The "for Home Assistant" form of the name is descriptive only, and the description ends "Not affiliated with Home Assistant or Elgato."
- [ ] The README, `PRIVACY.md` and the support link all work from outside (open each URL in a private window once the repository is public).

## Build and DRM steps (from the task plan, Step 7)

Publishing the repository, the version bump, the pack and the upload are the owner's steps. In order:

1. Search the Marketplace for "Spindle" to rule out a clash (see above).
2. Create the Maker Console account (https://maker.elgato.com/signin).
3. Pack: `npx @elgato/cli@1.10 pack com.vaguedustin.spindle.sdPlugin --output out` (CLI 1.6 or newer enables DRM by default). The manifest already has `SDKVersion` 3, a minimum Stream Deck version of 7.1 (the DRM minimum is 6.9) and `@elgato/streamdeck` 3.x (the DRM minimum is 2).
4. Create the product in Maker Console, upload `out/com.vaguedustin.spindle.streamDeckPlugin`, and fill in the listing from this sheet. **Leave "Publish after review" (labelled "Automatically publish after being approved" on the submit step) UNTICKED**, so the DRM build can be tested on hardware before anything goes live.
5. Download the DRM build: open the product's page, choose the **Versions** tab, select the new version, and download the DRM-protected build.
6. Install the DRM build (with any `streamdeck link` copy unlinked) and re-run `docs/hardware-checklist.md` against it (section 9). Fix any failures, which need a new version and a new upload.
7. Submit for review. Reviews took 4 to 10 working days when read, with feedback by email (maker@elgato.com is the contact).
8. After the plugin is approved, publish it from Maker Console. It can take up to 3 hours to appear.
9. Once it's listed, add the Marketplace badge to `README.md` (the `<!-- Elgato Marketplace badge -->` placeholder near the top) and commit.
