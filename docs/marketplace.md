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
| Author (as in the manifest) | VagueDustin Enterprises. The plugin guidelines ask for the Marketplace organization name, so the Maker Console organization name must match this exactly (the GitHub account and URLs stay `VagueDustin`). |
| Plugin UUID | `com.vaguedustin.spindle` (permanent once published). Action UUIDs: `.dial`, `.wide`, `.cover` and `.transport` under it |
| Supported devices | Stream Deck+ (dials and touch strip) for Now Playing and Now Playing (Wide); any Stream Deck with keys for Cover and Transport |
| Supported systems | Windows 10 and later, macOS 12 and later (macOS only once a Mac tester has passed section 10 of the hardware checklist; otherwise list Windows only) |
| Stream Deck app | 7.1 or newer |
| Support URL | https://github.com/VagueDustin/spindle-streamdeck/issues |
| Privacy URL | https://github.com/VagueDustin/spindle-streamdeck/blob/main/PRIVACY.md |
| Website / source link (optional) | https://github.com/VagueDustin/spindle-streamdeck |

Keywords to work into the description (Elgato asks for the supported software and devices to be named): Stream Deck+, Stream Deck, Home Assistant, media player, now playing, album art, volume dial, touch strip, media keys.

## Description

About 1,200 characters (Elgato's email-route limit is 1,500, and the Maker Console form states none). It matches the README.

```text
Spindle turns a Stream Deck+ dial into a live "now playing" display for any Home Assistant media player. The touch strip shows the cover art over a blurred backdrop, the title and artist (scrolling only when they don't fit, with real Japanese, Chinese and Korean glyphs), play bars and the volume. Turn the dial to set the volume with an instant on-strip readout, press it to switch to tracks mode and skip tracks, and tap the strip to play or pause. Put Now Playing (Wide) on two neighbouring dials for one wide display: the left dial sets the volume, the right dial skips tracks. On any Stream Deck, the Cover key shows the album art and the Transport key gives play/pause, next, previous, mute or volume with a live icon. Nothing needs to change on the Home Assistant side: paste your Home Assistant URL and a long-lived access token, pick a media player, and you're done. Spindle has no telemetry and talks only to your own Home Assistant. A dedicated non-admin Home Assistant user is recommended for the token. The dial actions need a Stream Deck+; the keys work on any Stream Deck. Requires Stream Deck 7.1 or newer and Home Assistant 2025.10 or newer. Not affiliated with Home Assistant or Elgato.
```

Rules for this text: English only, no Home Assistant logo or branding, no claims the README doesn't back. If the description changes, change the README to match.

## Reviewer notes

Spindle now ships four actions (Now Playing, Now Playing (Wide), Cover and Transport), inside Elgato's 2 to 30 range, so the single-action explanation used for 1.0.0 is no longer needed. If the form offers a reviewer-notes field, this helps with testing:

```text
Now Playing and Now Playing (Wide) need a Stream Deck+. Now Playing (Wide) is meant for two neighbouring dials: they pair automatically and the left dial holds the settings. Cover and Transport work on any key. All four share one Home Assistant URL and token, entered once in any action's settings.
```

## Release notes (1.0.0)

Paste the 1.0.0 section of `CHANGELOG.md`.

## Images

Elgato's current rules (from docs.elgato.com/maker-console/submitting-products, read 2026-10-15; check today, see the checklist):

- **Thumbnail:** PNG, 1920 x 960 px (2:1).
- **Gallery:** at least 3 items, up to 10. Each is a PNG at 1920 x 960 px, or an MP4 video at 1920 x 1080 px (50 MB at most, with a 1920 x 960 thumbnail).
- **Plugin icon:** PNG, 256 x 256 px and 512 x 512 px (`imgs/plugin/marketplace.png` and `marketplace@2x.png`).
- Images must show the real product and must be ones you own. Text in them must be English.

The README images in `docs/images/` are 600 x 300 px (the strip at 3x), so they are **not** the right size to upload. The gallery images below are composed for the Marketplace instead: 1920 x 960 PNG, each from a real hardware capture. The strip is rendered at 4.5x (900 x 450, straight from the capture's vector overlay, so nothing is stretched) and centred on a darkened, heavily blurred copy of that frame's own backdrop, with a short caption in Segoe UI. They are written through pngjs, so they carry no text or metadata chunks.

`npm run gallery:captures` rebuilds them from `docs/images/captures.json` (a still with `"marketplace": "<caption>"` gets one) when the local capture archive is present.

| File (1920 x 960) | Visible text | Use |
|---|---|---|
| `docs/images/marketplace/hero.png` | Title "Protocol Flow" (fully readable; it fits its window, so there is no scroll), artist "Metal Scar Radio", "Streaming", volume "25", caption "Now Playing" | Thumbnail and Gallery 1 |
| `docs/images/marketplace/takeover.png` | "VOLUME", "WE ARE EMPIRE", "32", caption "Volume" | Gallery 2 |
| `docs/images/marketplace/tracks.png` | "WE ARE EMP" (title scrolling), "STARSET", "Streaming", caption "Track skip" | Gallery 3 |
| `docs/images/marketplace/paused.png` | "WE ARE EMPIRE", "STARSET", "Streaming", pause glyph, "32", caption "Pause / play" | Gallery 4 |
| `docs/images/marketplace/cjk.png` | Chinese title, "Metal Scar Radio", "Streaming", "24", caption "Any language" | **Optional, probably leave out:** Elgato says text in gallery images must be English, and this one shows a Chinese title and CJK cover art. Use it only if the form accepts it (it shows the real CJK glyph support); the other four are English. |

The images show no device, machine or room name and no Home Assistant or Elgato logo. They do show **real album artwork as the plugin displays it** (the cover art of the playing track), which is third-party artwork: I must confirm this is acceptable under Elgato's "images must be ones you own" rule before submitting (see the checklist), or else replace the images with the procedural renders from `npm run screenshots`, which use generated art. The thumbnail (`marketplace/hero.png`) and the README hero (`docs/images/hero.png`) are a real capture of the track "Protocol Flow" by Metal Scar Radio from my deck. I chose a capture over the hardware photo that the original design called for, so there is no `hero.jpg` and none is pending.

The 600 x 300 README images map to the same scenes:

| File (600 x 300) | What it shows | Use |
|---|---|---|
| `docs/images/hero.png` | Rest view of "Protocol Flow" by Metal Scar Radio with the play bars showing, a real capture from my deck and the README hero (the same frame as the thumbnail above; `rest.png` is a different capture) | README; composed into the thumbnail above |
| `docs/images/rest.png` | Rest view, title scrolling, the Streaming source label | README only |
| `docs/images/takeover.png` | Volume takeover over a blurred cover | README; composed into Gallery 2 |
| `docs/images/tracks.png` | Tracks mode, forward chevrons flashing | README; composed into Gallery 3 |
| `docs/images/paused.png` | Paused, pause glyph in place of the play bars | README; composed into Gallery 4 |
| `docs/images/cjk.png` | A Chinese title with real glyphs | README; the optional (non-English) gallery image |
| `docs/images/no-art.png` | No cover art: gradient and placeholder | README; an optional extra |
| `docs/images/spindle.gif` | The title scrolling, then a volume takeover that fades back | Source for an MP4 (1920 x 1080) if a video is wanted; the Marketplace takes MP4, not GIF |

Elgato also says products that need hardware or paid-service integrations must include a demo video showing the plugin fully working. Spindle needs a Stream Deck+ and a Home Assistant server, so plan a short MP4 of the real deck (1920 x 1080, 50 MB or less) with a 1920 x 960 thumbnail (`docs/images/marketplace/hero.png` can serve). **Recording the demo video is my job** (see the checklist below); `spindle.gif` is only a reference for the scrolling-then-takeover sequence. Check today whether it is mandatory for this plugin.

No Home Assistant logo, Elgato logo or other branding goes in any image. The one third-party element is the album artwork the plugin shows, covered in the checklist.

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
- [ ] **Record the demo video:** a short MP4, 1920 x 1080, 50 MB or less, filmed on the real Stream Deck+ showing the plugin fully working: now playing with a scrolling title, turning the dial (volume takeover), pressing to switch to tracks mode and skipping a track, and tapping the strip to play or pause. No device, room, account or Home Assistant names on screen, and no third-party logos. Upload it to the gallery, with `docs/images/marketplace/hero.png` as its 1920 x 960 thumbnail.
- [ ] Gallery: upload the four English PNGs in `docs/images/marketplace/` (hero, takeover, tracks, paused; the table above says which is the thumbnail), leave out `cjk.png` unless the form accepts non-English text, and look at each one in the form preview.
- [ ] **Album-art ownership:** the gallery images and the demo video show real album artwork as displayed by the plugin. Confirm this is acceptable under Elgato's "images must be ones you own" rule before submitting. If it is not, replace the gallery with the procedural renders from `npm run screenshots` (generated art, nothing third-party), and film the video with a track whose artwork you own or with no artwork shown.
- [ ] Category list: Music / Audio is still offered. If it isn't, pick the nearest one and record it here.
- [ ] Guidelines that may affect Spindle, as read on 2026-10-15 (decide each one before submitting):
  - The plugin guidelines ask for **between 2 and 30 actions**. Spindle ships four, so this is met.
  - Icon sizes (done): the category icon is 28 x 28 px (56 x 56 at high DPI), the action icon 20 x 20 (40), the key image 72 x 72 (144) and the Marketplace icon 256 and 512 px, all generated by `npm run icons` from one glyph (a thick ring, solid hub and three gaps). Re-check the numbers against today's guidelines.
  - Category and action icons must be monochrome white (`#FFFFFF`) on a transparent background, with no colour and no solid background. Spindle's are, and the glyph is not the Home Assistant logo.
  - The category should be similar to the plugin name (it is "Spindle"), and action names should be about 30 characters or fewer ("Now Playing", "Now Playing (Wide)", "Cover", "Transport").
- [ ] **UUID and name**: search the Marketplace for "Spindle" before locking the UUID in with the first submission. If another plugin has that name or a close one, stop and decide on a new name before anything is uploaded. The UUID `com.vaguedustin.spindle` can't change once it is published.
- [ ] **No Home Assistant logo**: no HA logo, mark or branding in the plugin icon, the preview images, the video or the description. The "for Home Assistant" form of the name is descriptive only, and the description ends "Not affiliated with Home Assistant or Elgato."
- [ ] The README, `PRIVACY.md` and the support link all work from outside (open each URL in a private window once the repository is public).

## Build and DRM steps

Publishing the repository, the version bump, the pack and the upload are done by hand. In order:

1. Search the Marketplace for "Spindle" to rule out a clash (see above).
2. Create the Maker Console account (https://maker.elgato.com/signin).
3. Pack: `npx @elgato/cli@1.10 pack com.vaguedustin.spindle.sdPlugin --output out` (CLI 1.6 or newer enables DRM by default). The manifest already has `SDKVersion` 3, a minimum Stream Deck version of 7.1 (the DRM minimum is 6.9) and `@elgato/streamdeck` 3.x (the DRM minimum is 2).
4. Create the product in Maker Console, upload `out/com.vaguedustin.spindle.streamDeckPlugin`, and fill in the listing from this sheet. **Leave "Publish after review" (labelled "Automatically publish after being approved" on the submit step) UNTICKED**, so the DRM build can be tested on hardware before anything goes live.
5. Download the DRM build: open the product's page, choose the **Versions** tab, select the new version, and download the DRM-protected build.
6. Install the DRM build (with any `streamdeck link` copy unlinked) and re-run `docs/hardware-checklist.md` against it (section 9). Fix any failures, which need a new version and a new upload.
7. Submit for review. Reviews took 4 to 10 working days when read, with feedback by email (maker@elgato.com is the contact).
8. After the plugin is approved, publish it from Maker Console. It can take up to 3 hours to appear.
9. Once it's listed, add the Marketplace badge to `README.md` (the `<!-- Elgato Marketplace badge -->` placeholder near the top) and commit.
