// Rasterises renderer output the way the strip shows it: the bg PNG with the fg SVG
// alpha-composited on top. resvg loads no system fonts, only the committed Noto Sans
// fixture, so renders are identical on every machine.
import { Resvg } from "@resvg/resvg-js";
import { PNG } from "pngjs";
import type { Rgba } from "../../src/art/image";

const FONT = {
	loadSystemFonts: false,
	fontFiles: ["test/fixtures/NotoSans-Regular.ttf"],
	defaultFontFamily: "Noto Sans",
	sansSerifFamily: "Noto Sans"
};

function decodePng(bytes: Uint8Array): Rgba {
	const png = PNG.sync.read(Buffer.from(bytes));
	return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

/** Decodes a `data:image/png;base64,...` URI. */
export function decodeDataUri(uri: string): Rgba {
	const prefix = "data:image/png;base64,";
	if (!uri.startsWith(prefix)) throw new Error(`not a PNG data URI: ${uri.slice(0, 32)}`);
	return decodePng(Buffer.from(uri.slice(prefix.length), "base64"));
}

/** Renders an SVG string to straight-alpha RGBA. Throws if resvg rejects it. */
export function rasterise(svg: string): Rgba {
	// asPng() demultiplies alpha; the raw pixel buffer is premultiplied.
	return decodePng(new Resvg(svg, { font: FONT }).render().asPng());
}

/** Source-over composite of `top` onto `bottom` (same size). */
export function over(bottom: Rgba, top: Rgba): Rgba {
	const data = new Uint8Array(bottom.data.length);
	for (let i = 0; i < data.length; i += 4) {
		const ta = top.data[i + 3] / 255;
		const ba = bottom.data[i + 3] / 255;
		const a = ta + ba * (1 - ta);
		for (let c = 0; c < 3; c++) {
			const v = a === 0 ? 0 : (top.data[i + c] * ta + bottom.data[i + c] * ba * (1 - ta)) / a;
			data[i + c] = Math.round(v);
		}
		data[i + 3] = Math.round(a * 255);
	}
	return { width: bottom.width, height: bottom.height, data };
}

/** What the strip shows: the backdrop PNG with the foreground SVG over it. */
export function compose(bgDataUri: string, fgSvg: string): Rgba {
	return over(decodeDataUri(bgDataUri), rasterise(fgSvg));
}

/** PNG bytes with no ancillary text chunks (pngjs writes none). */
export function toPng(img: Rgba): Buffer {
	const png = new PNG({ width: img.width, height: img.height });
	png.data = Buffer.from(img.data);
	return PNG.sync.write(png);
}

export function readPng(bytes: Uint8Array): Rgba {
	return decodePng(bytes);
}
