// Draws the Spindle glyph as SVG and rasterises it with resvg into the plugin's imgs folder.
// Run with `npm run icons`.
//
// The glyph is a thick ring (outer radius 44, inner 26 in a 100x100 box) with a solid hub and three
// wide gaps. Category, action and key icons are white on transparent with no logo, as Elgato's
// guidelines ask; the Marketplace icon is the same glyph smaller on a dark accent disc.
import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "com.vaguedustin.spindle.sdPlugin", "imgs");

/** Size in px of the category icon: Elgato's guideline is 28 (56 at high DPI). */
const CATEGORY = 28;

/** A gap cut straight across the ring at `deg`, from beyond the rim in to just inside the ring's inner edge. */
const gap = (deg: number): string => `<rect x="-4.5" y="-50" width="9" height="28" rx="1" transform="rotate(${deg})" fill="black"/>`;

/** Thick ring r=35 stroked 18 wide (44/26), three gaps, and a solid hub r=11, about the origin. */
function glyph(fill: string, scale: number): string {
	const gaps = [0, 120, 240].map(gap).join("");
	return `<g transform="translate(50 50) scale(${scale})">
	<mask id="gaps" maskUnits="userSpaceOnUse" x="-50" y="-50" width="100" height="100">
		<rect x="-50" y="-50" width="100" height="100" fill="white"/>
		${gaps}
	</mask>
	<g mask="url(#gaps)">
		<circle r="35" fill="none" stroke="${fill}" stroke-width="18"/>
	</g>
	<circle r="11" fill="${fill}"/>
</g>`;
}

function svg(background: string | null, scale: number): string {
	const disc = background ? `<circle cx="50" cy="50" r="50" fill="${background}"/>` : "";
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${disc}${glyph("#ffffff", scale)}</svg>`;
}

function render(markup: string, size: number): Buffer {
	const resvg = new Resvg(markup, {
		fitTo: { mode: "width", value: size },
		font: { loadSystemFonts: false }
	});
	return resvg.render().asPng();
}

function write(rel: string, markup: string, size: number): void {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, render(markup, size));
	console.log(`${rel} (${size}x${size})`);
}

const disc = svg("#2d2a5e", 0.64);
const plain = svg(null, 1);

write("plugin/marketplace.png", disc, 256);
write("plugin/marketplace@2x.png", disc, 512);
write("plugin/category-icon.png", plain, CATEGORY);
write("plugin/category-icon@2x.png", plain, CATEGORY * 2);
write("actions/dial/icon.png", plain, 20);
write("actions/dial/icon@2x.png", plain, 40);
write("actions/dial/key.png", plain, 72);
write("actions/dial/key@2x.png", plain, 144);

// The other actions: plain white shapes in the same 100x100 box, so the action list tells them apart.
const shape = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
/** Wide: two strip segments side by side, read as one. */
const wide = shape(
	`<rect x="4" y="30" width="44" height="40" rx="6" fill="#fff"/><rect x="52" y="30" width="44" height="40" rx="6" fill="#fff"/>` +
		`<rect x="44" y="44" width="12" height="12" fill="#fff"/>`
);
/** Cover: a framed square with the Spindle hub as the record in it. */
const cover = shape(
	`<rect x="10" y="10" width="80" height="80" rx="10" fill="none" stroke="#fff" stroke-width="9"/><circle cx="50" cy="50" r="20" fill="#fff"/>`
);
/** Transport: play beside pause. */
const transport = shape(
	`<path d="M8 22L46 50L8 78Z" fill="#fff"/><rect x="58" y="22" width="13" height="56" rx="2" fill="#fff"/><rect x="80" y="22" width="13" height="56" rx="2" fill="#fff"/>`
);

for (const [name, markup] of [
	["wide", wide],
	["cover", cover],
	["transport", transport]
] as const) {
	write(`actions/${name}/icon.png`, markup, 20);
	write(`actions/${name}/icon@2x.png`, markup, 40);
	write(`actions/${name}/key.png`, markup, 72);
	write(`actions/${name}/key@2x.png`, markup, 144);
}
