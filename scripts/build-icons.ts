// Draws the Spindle glyph as SVG and rasterises it with resvg into the plugin's imgs folder.
// Run with `npm run icons`. Task 15 refines the art.
import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "com.vaguedustin.spindle.sdPlugin", "imgs");

/** Disc r=34 with a centre hole (r=8) and three radial notches, centred in a 100x100 box. */
function glyph(fill: string, scale = 1): string {
	const notches = [0, 120, 240]
		.map((deg) => `<rect x="-3.5" y="-36" width="7" height="20" rx="1.5" transform="rotate(${deg})" fill="black"/>`)
		.join("");
	return `<g transform="translate(50 50) scale(${scale})">
	<mask id="cut" maskUnits="userSpaceOnUse" x="-50" y="-50" width="100" height="100">
		<rect x="-50" y="-50" width="100" height="100" fill="white"/>
		<circle r="8" fill="black"/>
		${notches}
	</mask>
	<circle r="34" fill="${fill}" mask="url(#cut)"/>
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

const disc = svg("#2d2a5e", 0.8);
const plain = svg(null, 1.35);

write("plugin/marketplace.png", disc, 256);
write("plugin/marketplace@2x.png", disc, 512);
write("plugin/category-icon.png", plain, 20);
write("plugin/category-icon@2x.png", plain, 40);
write("actions/dial/icon.png", plain, 20);
write("actions/dial/icon@2x.png", plain, 40);
write("actions/dial/key.png", plain, 72);
write("actions/dial/key@2x.png", plain, 144);
