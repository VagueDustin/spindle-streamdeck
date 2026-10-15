// Sets the manifest Version to `${package.json version}.0`. Run via `npm version`.
import fs from "node:fs";

const manifestPath = "com.vaguedustin.spindle.sdPlugin/manifest.json";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

manifest.Version = `${pkg.version}.0`;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t") + "\n");
console.log(`manifest Version -> ${manifest.Version}`);
