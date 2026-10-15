import type { Rgb } from "../../src/art/accent";
import type { PlayerState } from "../../src/ha/playerState";
import { composeSingle, escapeXml, renderForeground, type DialUi } from "../../src/render/foreground";
import { estimateWidth } from "../../src/render/textWidth";
import { rasterise } from "../helpers/compose";

const ACCENT: Rgb = [90, 200, 160];
const ACCENT_CSS = "rgb(90,200,160)";
const LONG_TITLE = "An Extremely Long Song Title That Cannot Possibly Fit";

const player = (over: Partial<PlayerState> = {}): PlayerState => ({
	entityId: "media_player.living_room",
	status: "playing",
	friendlyName: "Living Room",
	title: "Short",
	artist: "Band",
	volume: 40,
	muted: false,
	features: 0,
	...over
});

const ui = (over: Partial<DialUi> = {}): DialUi => ({
	mode: "volume",
	volume: 40,
	muted: false,
	volumeDisplay: "number",
	takeoverAlpha: 0,
	flashDir: 0,
	offset: 0,
	dimmed: false,
	buffering: false,
	...over
});

/** Stack-based XML well-formedness check: balanced tags, and no raw & < > in text or attribute values. */
function assertWellFormed(svg: string) {
	const stack: string[] = [];
	const token = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|([^<]+)/gy;
	let consumed = 0;
	for (const m of svg.matchAll(token)) {
		consumed += m[0].length;
		const [, close, name, attrs, selfClose, text] = m;
		if (text !== undefined) {
			expect(text).not.toMatch(/[<>]|&(?!(?:amp|lt|gt|quot|apos);)/);
			continue;
		}
		for (const a of attrs.matchAll(/="([^"]*)"/g)) expect(a[1]).not.toMatch(/[<>]|&(?!(?:amp|lt|gt|quot|apos);)/);
		if (close) expect(stack.pop()).toBe(name);
		else if (!selfClose) stack.push(name);
	}
	expect(consumed).toBe(svg.length);
	expect(stack).toEqual([]);
}

/** Every `<text>` element's content, unescaped tags stripped. */
const texts = (svg: string) => [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map((m) => ({ attrs: m[1], body: m[2] }));
const num = (attrs: string, name: string) => Number(new RegExp(`\\b${name}="([-\\d.]+)"`).exec(attrs)?.[1]);

describe("escapeXml", () => {
	test("escapes the five XML specials", () => {
		expect(escapeXml(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
	});

	test("strips characters that are invalid in XML 1.0, keeps tab/newline and emoji", () => {
		const bad = "\u0000\u0001\u0008\u000B\u000C\u000E\u001F\uFFFE\uFFFF";
		expect(escapeXml(`a${bad}b`)).toBe("ab");
		expect(escapeXml("a\tb\nc\rd")).toBe("a\tb\nc\rd");
		expect(escapeXml("lone \uD83D high, lone \uDD25 low")).toBe("lone  high, lone  low");
		expect(escapeXml("fire 🔥 ok")).toBe("fire 🔥 ok");
	});
});

describe("renderForeground: XML safety (Review Focus 1)", () => {
	test("a title full of specials and emoji renders through resvg and keeps its text", () => {
		const title = `AC/DC — Back in Black & <Live> "x" 🔥`;
		const f = renderForeground(player({ title, artist: `'Quoted' & \u0007bell` }), ui(), ACCENT, 0);
		assertWellFormed(f.svg);
		expect(f.svg).toContain("&amp;");
		expect(f.svg).toContain("&lt;Live&gt;");
		expect(f.svg).toContain("&quot;x&quot;");
		expect(f.svg).toContain("🔥");
		expect(f.svg).not.toContain("\u0007");
		expect(() => rasterise(f.svg)).not.toThrow();
	});

	test("every view is well-formed and renders", () => {
		const frames = [
			renderForeground(player(), ui(), ACCENT, 0),
			renderForeground(player({ title: LONG_TITLE }), ui({ offset: 50 }), ACCENT, 100),
			renderForeground(player(), ui({ takeoverAlpha: 0.5 }), ACCENT, 0),
			renderForeground(player(), ui({ mode: "tracks", flashDir: -1 }), ACCENT, 0),
			renderForeground(null, ui({ message: { headline: "Check <token> & retry", sub: "a\u0000b" }, dimmed: true, badge: "Reconnecting…" }), ACCENT, 0),
			renderForeground(null, ui(), ACCENT, 0)
		];
		for (const f of frames) {
			assertWellFormed(f.svg);
			expect(() => rasterise(f.svg)).not.toThrow();
		}
	});

	test("emits the single unquoted font family", () => {
		const svg = renderForeground(player(), ui(), ACCENT, 0).svg;
		expect(svg).toContain('font-family="Segoe UI"');
		expect(svg).not.toMatch(/font-family="[^"]*[,']/);
	});
});

describe("renderForeground: frame flags", () => {
	test("paused with fitting text is static", () => {
		expect(renderForeground(player({ status: "paused" }), ui(), ACCENT, 0)).toMatchObject({ animating: false, halfRate: false });
	});

	test("playing with fitting text animates the bars at half rate", () => {
		expect(renderForeground(player(), ui(), ACCENT, 0)).toMatchObject({ animating: true, halfRate: true });
		expect(renderForeground(player({ status: "buffering" }), ui({ buffering: true }), ACCENT, 0)).toMatchObject({ animating: true, halfRate: true });
	});

	test("an overflowing title scrolls at full rate in a clipped box with two copies 28 px apart", () => {
		const offset = 30;
		const f = renderForeground(player({ status: "paused", title: LONG_TITLE }), ui({ offset }), ACCENT, 0);
		expect(f).toMatchObject({ animating: true, halfRate: false });
		expect(f.svg).toMatch(/<clipPath id="[^"]+"><rect x="74" y="0" width="120" height="100"\/><\/clipPath>/);
		const copies = texts(f.svg).filter((t) => t.body === LONG_TITLE);
		expect(copies).toHaveLength(2);
		const w = estimateWidth(LONG_TITLE, { size: 17, weight: 600 });
		const [x1, x2] = copies.map((c) => num(c.attrs, "x"));
		expect(x1).toBeCloseTo(74 - (offset % (w + 28)), 0);
		expect(x2 - x1).toBeCloseTo(w + 28, 0);
		// Fitting artist does not scroll.
		expect(texts(f.svg).filter((t) => t.body === "Band")).toHaveLength(1);
	});

	test("the artist scrolls on its own when only it overflows", () => {
		const f = renderForeground(player({ status: "paused", artist: LONG_TITLE }), ui({ offset: 10 }), ACCENT, 0);
		expect(f.animating).toBe(true);
		expect(texts(f.svg).filter((t) => t.body === LONG_TITLE)).toHaveLength(2);
		expect(texts(f.svg).filter((t) => t.body === "Short")).toHaveLength(1);
	});

	test("takeover does not change the flags", () => {
		expect(renderForeground(player({ status: "paused" }), ui({ takeoverAlpha: 1 }), ACCENT, 0)).toMatchObject({ animating: false, halfRate: false });
	});

	test("no player and no message: an empty transparent SVG", () => {
		const f = renderForeground(null, ui(), ACCENT, 0);
		expect(f).toMatchObject({ animating: false, halfRate: false });
		expect(f.svg).not.toContain("<text");
		const img = rasterise(f.svg);
		expect(img.data.every((v, i) => i % 4 !== 3 || v === 0)).toBe(true);
	});
});

describe("renderForeground: rest view", () => {
	test("bars in the accent at x=74, base y=64, with the spec's heights; halved when buffering", () => {
		const t = 1234;
		const bars = (svg: string) => [...svg.matchAll(new RegExp(`<rect x="([\\d.]+)" y="([\\d.]+)" width="3" height="([\\d.]+)" rx="1.5" fill="${ACCENT_CSS.replace(/[()]/g, "\\$&")}"/>`, "g"))];
		const full = bars(renderForeground(player(), ui(), ACCENT, t).svg);
		expect(full).toHaveLength(3);
		full.forEach((m, i) => {
			const h = 3 + Math.abs(Math.sin(t * 0.006 + i * 1.9)) * 9;
			expect(Number(m[1])).toBeCloseTo(74 + i * 5, 1);
			expect(Number(m[3])).toBeCloseTo(h, 0);
			expect(Number(m[2]) + Number(m[3])).toBeCloseTo(64, 0);
		});
		const half = bars(renderForeground(player({ status: "buffering" }), ui({ buffering: true }), ACCENT, t).svg);
		half.forEach((m, i) => expect(Number(m[3])).toBeCloseTo((3 + Math.abs(Math.sin(t * 0.006 + i * 1.9)) * 9) / 2, 0));
	});

	test("paused shows the white pause glyph instead of bars", () => {
		const svg = renderForeground(player({ status: "paused" }), ui(), ACCENT, 0).svg;
		expect(svg).not.toMatch(/width="3" height="[\d.]+" rx="1.5"/);
		expect(svg).toMatch(/<rect x="75" y="54" width="3" height="10" rx="1" fill="#fff"/);
		expect(svg).toMatch(/<rect x="81" y="54" width="3" height="10" rx="1" fill="#fff"/);
	});

	test("title and artist slots use the spec's fonts", () => {
		const ts = texts(renderForeground(player(), ui(), ACCENT, 0).svg);
		const title = ts.find((t) => t.body === "Short")!;
		const artist = ts.find((t) => t.body === "Band")!;
		expect(title.attrs).toMatch(/x="74"/);
		expect(title.attrs).toMatch(/font-size="17" font-weight="600" fill="#fff"/);
		expect(artist.attrs).toMatch(/x="74"/);
		expect(artist.attrs).toMatch(/font-size="13" font-weight="400" fill="#fff" fill-opacity="0.72"/);
	});

	test("the source label is 11 px white 0.6 at x=92", () => {
		const ts = texts(renderForeground(player(), ui({ sourceLabel: "Spotify" }), ACCENT, 0).svg);
		const label = ts.find((t) => t.body === "Spotify")!;
		expect(label.attrs).toMatch(/x="92"/);
		expect(label.attrs).toMatch(/font-size="11"/);
		expect(label.attrs).toMatch(/fill-opacity="0.6"/);
	});

	test("no title: friendly name and the status word", () => {
		const f = renderForeground(player({ status: "idle", title: undefined, artist: undefined }), ui(), ACCENT, 0);
		const bodies = texts(f.svg).map((t) => t.body);
		expect(bodies).toContain("Living Room");
		expect(bodies).toContain("Idle");
		expect(f.animating).toBe(false);
	});

	test("volume row: a 150 px track at 0.22, an accent fill and the number right-aligned at x=194", () => {
		const svg = renderForeground(player(), ui({ volume: 50 }), ACCENT, 0).svg;
		expect(svg).toMatch(/<rect x="8" y="80" width="150" height="6" rx="3" fill="#fff" fill-opacity="0.22"\/>/);
		expect(svg).toContain(`<rect x="8" y="80" width="75" height="6" rx="3" fill="${ACCENT_CSS}"/>`);
		const n = texts(svg).find((t) => t.body === "50")!;
		expect(n.attrs).toMatch(/x="194"/);
		expect(n.attrs).toMatch(/text-anchor="end"/);
		expect(n.attrs).toMatch(/font-size="20" font-weight="700"/);
	});

	test("muted: MUTE in red replaces the number and the fill turns white 0.35", () => {
		const svg = renderForeground(player(), ui({ volume: 50, muted: true }), ACCENT, 0).svg;
		const mute = texts(svg).find((t) => t.body === "MUTE")!;
		expect(mute.attrs).toContain('fill="rgb(255,110,110)"');
		expect(texts(svg).some((t) => t.body === "50")).toBe(false);
		expect(svg).toContain('<rect x="8" y="80" width="75" height="6" rx="3" fill="#fff" fill-opacity="0.35"/>');
	});

	test('"hidden" shows no volume row; "bar-only" shows the track without a number', () => {
		const hidden = renderForeground(player(), ui({ volumeDisplay: "hidden" }), ACCENT, 0).svg;
		expect(hidden).not.toContain('width="150"');
		expect(texts(hidden).some((t) => t.body === "40")).toBe(false);
		const barOnly = renderForeground(player(), ui({ volumeDisplay: "bar-only" }), ACCENT, 0).svg;
		expect(barOnly).toContain('width="150"');
		expect(texts(barOnly).some((t) => t.body === "40")).toBe(false);
	});
});

describe("renderForeground: takeover", () => {
	test("alpha 1: a 0.62 black overlay and the number at 44 px", () => {
		const svg = renderForeground(player(), ui({ takeoverAlpha: 1, volume: 64 }), ACCENT, 0).svg;
		expect(svg).toContain('<rect x="0" y="0" width="200" height="100" fill="#000" opacity="0.62"/>');
		const big = texts(svg).find((t) => t.body === "64" && /font-size="44"/.test(t.attrs))!;
		expect(big).toBeDefined();
		expect(big.attrs).toMatch(/x="100"/);
		expect(big.attrs).toMatch(/text-anchor="middle"/);
		expect(texts(svg).some((t) => t.body === "VOLUME")).toBe(true);
		expect(svg).toMatch(/<circle cx="[\d.]+" cy="84" r="6" fill="#fff"\/>/);
	});

	test("alpha 0: no overlay and no big number", () => {
		const svg = renderForeground(player(), ui({ takeoverAlpha: 0 }), ACCENT, 0).svg;
		expect(svg).not.toContain('opacity="0.62"');
		expect(svg).not.toContain('font-size="44"');
	});

	test("a partial alpha fades the takeover in as a group", () => {
		const svg = renderForeground(player(), ui({ takeoverAlpha: 0.4 }), ACCENT, 0).svg;
		expect(svg).toContain('<g opacity="0.4">');
		expect(svg).toContain('opacity="0.62"');
	});

	test('"bar-only" shows the bar and no number', () => {
		const svg = renderForeground(player(), ui({ takeoverAlpha: 1, volumeDisplay: "bar-only" }), ACCENT, 0).svg;
		expect(svg).not.toContain('font-size="44"');
		expect(svg).toMatch(/<circle /);
	});
});

describe("renderForeground: tracks mode", () => {
	/** Mean x of each chevron group's polygon points. */
	const chevronCentres = (svg: string) =>
		[...svg.matchAll(/<path d="([^"]+)" fill="([^"]+)"( fill-opacity="[\d.]+")?\/>/g)].map((m) => {
			const xs = [...m[1].matchAll(/[ML]([-\d.]+) /g)].map((p) => Number(p[1]));
			return { x: (Math.min(...xs) + Math.max(...xs)) / 2, fill: m[2] };
		});

	test("back and forward chevrons at x≈60 and x≈140 with a centre dot, and no volume number", () => {
		const svg = renderForeground(player(), ui({ mode: "tracks" }), ACCENT, 0).svg;
		const groups = chevronCentres(svg);
		expect(groups).toHaveLength(2);
		expect(Math.abs(groups[0].x - 60)).toBeLessThanOrEqual(2);
		expect(Math.abs(groups[1].x - 140)).toBeLessThanOrEqual(2);
		expect(groups.every((g) => g.fill === "#fff")).toBe(true);
		expect(svg).toMatch(/<circle cx="100" cy="83" r="3"/);
		expect(texts(svg).some((t) => t.body === "40")).toBe(false);
		expect(svg).not.toContain('width="150"');
	});

	test("flashDir 1 paints the forward chevrons in the accent", () => {
		const groups = chevronCentres(renderForeground(player(), ui({ mode: "tracks", flashDir: 1 }), ACCENT, 0).svg);
		expect(groups[0].fill).toBe("#fff");
		expect(groups[1].fill).toBe(ACCENT_CSS);
	});

	test("there is no takeover in tracks mode", () => {
		expect(renderForeground(player(), ui({ mode: "tracks", takeoverAlpha: 1 }), ACCENT, 0).svg).not.toContain('opacity="0.62"');
	});
});

describe("renderForeground: messages, dim and badge", () => {
	test("a message replaces title and artist, with no bars, no volume row and no animation", () => {
		const f = renderForeground(player(), ui({ message: { headline: "Not found", sub: "media_player.den" } }), ACCENT, 0);
		const ts = texts(f.svg);
		const headline = ts.find((t) => t.body === "Not found")!;
		expect(headline.attrs).toMatch(/x="74"/);
		expect(headline.attrs).toMatch(/font-size="17" font-weight="600"/);
		expect(ts.find((t) => t.body === "media_player.den")!.attrs).toMatch(/font-size="13"/);
		expect(ts.some((t) => t.body === "Short" || t.body === "Band")).toBe(false);
		expect(f.svg).not.toContain('width="150"');
		expect(f).toMatchObject({ animating: false, halfRate: false });
	});

	test("an overflowing message is truncated with an ellipsis rather than scrolled", () => {
		const f = renderForeground(null, ui({ message: { headline: LONG_TITLE } }), ACCENT, 0);
		const headline = texts(f.svg)[0].body;
		expect(headline.endsWith("…")).toBe(true);
		expect(estimateWidth(headline, { size: 17, weight: 600 })).toBeLessThanOrEqual(120);
		expect(f.animating).toBe(false);
	});

	test("dimmed adds a 0.5 black overlay after the content; the badge sits above it", () => {
		const svg = renderForeground(player(), ui({ dimmed: true, badge: "Reconnecting…" }), ACCENT, 0).svg;
		const dim = svg.indexOf('<rect x="0" y="0" width="200" height="100" fill="#000" opacity="0.5"/>');
		expect(dim).toBeGreaterThan(svg.indexOf(">Short<"));
		const badge = svg.indexOf(">Reconnecting…<");
		expect(badge).toBeGreaterThan(dim);
	});

	test("no dim overlay when not dimmed", () => {
		expect(renderForeground(player(), ui(), ACCENT, 0).svg).not.toContain('opacity="0.5"');
	});
});

describe("composeSingle", () => {
	test("inserts the backdrop as the first child of the root svg", () => {
		const fg = renderForeground(player(), ui(), ACCENT, 0).svg;
		const out = composeSingle("data:image/png;base64,AAAA", fg);
		expect(out).toMatch(/^<svg [^>]*><image href="data:image\/png;base64,AAAA" x="0" y="0" width="200" height="100"\/>/);
		expect(out.endsWith("</svg>")).toBe(true);
		expect(out.length).toBe(fg.length + '<image href="data:image/png;base64,AAAA" x="0" y="0" width="200" height="100"/>'.length);
	});
});

describe("renderForeground: frame cost (spec 4.3)", () => {
	test("averages under 1 ms per frame on a scrolling, playing state", () => {
		const p = player({ title: LONG_TITLE, artist: `${LONG_TITLE} (Remastered)` });
		const u = ui({ sourceLabel: "Spotify" });
		for (let i = 0; i < 200; i++) renderForeground(p, { ...u, offset: i * 2.4 }, ACCENT, i * 100);
		const n = 1000;
		const start = performance.now();
		for (let i = 0; i < n; i++) renderForeground(p, { ...u, offset: i * 2.4 }, ACCENT, i * 100);
		const avg = (performance.now() - start) / n;
		expect(avg).toBeLessThan(process.env.CI ? 3 : 1);
	});
});
