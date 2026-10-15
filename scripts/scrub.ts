// Pre-publish scrub (spec §11). Run with `npm run scrub`; CI runs it on every push.
//
// Generic tier (always on): private IPv4, JWT-shaped strings, webhook API paths, PNG text chunks and
// metadata, and commit emails that are not noreply addresses.
// Local tier (developer machines): literals from the untracked `.scrub-local.txt`, one per line. They are
// never echoed in output, because this script's logs end up in public CI runs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface Hit {
	file: string;
	line: number;
	pattern: string;
}

/** Spans that are fine even when a denylist literal sits inside them (the copyright holder). */
const ALLOWLIST = ["Dustin Szabo"];
/** The documentation example address; every other private IPv4 is a hit. */
const ALLOWED_IP = "192.168.1.10";
const WEBHOOK_PATH = "/api/" + "webhook/";

// Boundaries stop version strings like 1.10.0.0.5 or 110.1.2.3 from matching.
const IPV4_BOUNDARY_START = String.raw`(?<![\w.])`;
const IPV4_BOUNDARY_END = String.raw`(?!\w|\.\d)`;
const PRIVATE_IPV4 = new RegExp(
	IPV4_BOUNDARY_START +
		String.raw`(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})` +
		IPV4_BOUNDARY_END,
	"g"
);
// A realistic JWT: base64url header starting eyJ plus a payload segment, each long enough to be real.
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?/;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_METADATA_CHUNKS = new Set(["tEXt", "iTXt", "zTXt", "eXIf"]);

/** The vendored Elgato bundle is minified third-party code: only the local literals apply to it. */
const VENDORED = new Set(["com.vaguedustin.spindle.sdPlugin/ui/sdpi-components.js"]);
const LOCAL_FILE = ".scrub-local.txt";
const NOREPLY = /@users\.noreply\.github\.com$/i;
const ANTHROPIC = "noreply@anthropic.com";
/** GitHub's web-flow committer for merges and squashes made in the web UI; accepted for committers only. */
const GITHUB_WEB = "noreply@github.com";
const HISTORY = "(git history)";
const RECORD_SEP = "\x1e";
const UNIT_SEP = "\x1f";

export function parseDenylist(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
}

function lines(text: string): string[] {
	return text.split(/\r?\n/);
}

/** Replaces allowlisted spans with spaces (same length) so literals inside them cannot match. */
function maskAllowlisted(line: string): string {
	let masked = line;
	for (const allowed of ALLOWLIST) {
		const lowered = allowed.toLowerCase();
		let from = 0;
		for (;;) {
			const at = masked.toLowerCase().indexOf(lowered, from);
			if (at < 0) break;
			masked = masked.slice(0, at) + " ".repeat(allowed.length) + masked.slice(at + allowed.length);
			from = at + allowed.length;
		}
	}
	return masked;
}

/** Local tier only: case-insensitive literals, minus allowlisted spans. */
export function scanLiterals(text: string, file: string, extra: string[]): Hit[] {
	const literals = extra.map((literal) => literal.trim().toLowerCase());
	const hits: Hit[] = [];
	lines(text).forEach((line, i) => {
		const haystack = maskAllowlisted(line).toLowerCase();
		literals.forEach((literal, n) => {
			if (literal !== "" && haystack.includes(literal)) {
				hits.push({ file, line: i + 1, pattern: `local-denylist#${n + 1}` });
			}
		});
	});
	return hits;
}

/** Both tiers over one text file. */
export function scanText(text: string, file: string, extra: string[]): Hit[] {
	const hits: Hit[] = [];
	lines(text).forEach((line, i) => {
		const lineNo = i + 1;
		if ([...line.matchAll(PRIVATE_IPV4)].some((m) => m[0] !== ALLOWED_IP)) {
			hits.push({ file, line: lineNo, pattern: "private-ipv4" });
		}
		if (JWT.test(line)) hits.push({ file, line: lineNo, pattern: "jwt" });
		if (line.includes(WEBHOOK_PATH)) hits.push({ file, line: lineNo, pattern: "webhook-path" });
	});
	hits.push(...scanLiterals(text, file, extra));
	return hits.sort((a, b) => a.line - b.line);
}

/** Returns the metadata chunk types found in a PNG (empty when clean). */
export function scanPng(bytes: Uint8Array): string[] {
	if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return ["not-a-png"];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const found: string[] = [];
	let at = 8;
	while (at + 12 <= bytes.length) {
		const length = view.getUint32(at);
		const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
		if (PNG_METADATA_CHUNKS.has(type)) found.push(type);
		if (type === "IEND") break;
		at += 12 + length;
	}
	return found;
}

/** True when every Co-Authored-By value carries a parseable, allowed email (case-insensitive). */
function trailersAllowed(trailers: string): boolean {
	return trailers
		.split(new RegExp(`${UNIT_SEP}|\\n`))
		.filter((value) => value.trim() !== "")
		.every((value) => {
			const email = /<([^>]+)>/.exec(value)?.[1]?.trim().toLowerCase();
			return email !== undefined && (email === ANTHROPIC || NOREPLY.test(email));
		});
}

/** Problems with the local denylist file itself; a silently useless denylist is worse than none. */
export function denylistWarnings(raw: string, entries: string[]): string[] {
	const warnings: string[] = [];
	if (raw.includes("\0")) warnings.push("local denylist contains NUL characters (UTF-16 file?); save it as UTF-8");
	if (entries.length === 0) warnings.push("local denylist has no entries");
	return warnings;
}

/**
 * Checks the output of `git log --all` formatted as record-separator, short sha, author email,
 * committer email and Co-Authored-By trailer values (tab and unit-separator delimited).
 * Authors must be GitHub noreply addresses; committers may also be GitHub's web-flow address;
 * co-authors may also be Anthropic's. A Co-Authored-By value without a parseable email is a hit.
 */
export function checkCommitEmails(log: string): Hit[] {
	const hits: Hit[] = [];
	for (const record of log.split(RECORD_SEP).filter((r) => r.trim() !== "")) {
		const [sha, author = "", committer = "", trailers = ""] = record.split("\t");
		const flag = (what: string) => hits.push({ file: HISTORY, line: 0, pattern: `commit ${sha}: ${what}` });
		if (!NOREPLY.test(author.trim())) flag("author email");
		const committerEmail = committer.trim();
		if (!NOREPLY.test(committerEmail) && committerEmail.toLowerCase() !== GITHUB_WEB) flag("committer email");
		if (!trailersAllowed(trailers)) flag("Co-Authored-By email");
	}
	return hits;
}

function git(root: string, args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function isBinary(bytes: Uint8Array): boolean {
	return bytes.subarray(0, 8000).includes(0);
}

function main(): number {
	const root = path.resolve(import.meta.dirname, "..");
	const localPath = path.join(root, LOCAL_FILE);
	const hasLocal = fs.existsSync(localPath);
	const rawLocal = hasLocal ? fs.readFileSync(localPath, "utf8") : "";
	const extra = parseDenylist(rawLocal);
	if (hasLocal) for (const warning of denylistWarnings(rawLocal, extra)) console.warn(`scrub: ${warning}`);
	if (!hasLocal && !process.env.CI) console.warn("scrub: local denylist missing (create .scrub-local.txt, see spec §11)");

	const hits: Hit[] = [];
	const skipped: string[] = [];
	let texts = 0;
	let pngs = 0;
	for (const file of git(root, ["ls-files", "-z"]).split("\0").filter(Boolean)) {
		const full = path.join(root, file);
		if (file.split("/").includes("node_modules") || !fs.existsSync(full)) continue;
		const bytes = fs.readFileSync(full);
		if (file.toLowerCase().endsWith(".png")) {
			pngs++;
			for (const chunk of scanPng(bytes)) hits.push({ file, line: 0, pattern: `png-metadata:${chunk}` });
		} else if (isBinary(bytes)) {
			skipped.push(file);
		} else {
			texts++;
			const text = bytes.toString("utf8");
			hits.push(...(VENDORED.has(file) ? scanLiterals(text, file, extra) : scanText(text, file, extra)));
		}
	}

	let history: string;
	try {
		const trailer = "%(trailers:key=Co-Authored-By,valueonly,separator=%x1f)";
		history = git(root, ["log", "--all", `--format=%x1e%h%x09%ae%x09%ce%x09${trailer}`]);
	} catch {
		history = ""; // no commits yet
	}
	hits.push(...checkCommitEmails(history));

	for (const file of skipped) console.log(`scrub: skipped binary ${file}`);
	for (const hit of hits) console.error(hit.line > 0 ? `${hit.file}:${hit.line}: ${hit.pattern}` : `${hit.file}: ${hit.pattern}`);
	const local = hasLocal ? `local denylist: ${extra.length} entries` : "local denylist: missing";
	console.log(`scrub: ${hits.length} hits (${texts} text, ${pngs} png, ${skipped.length} binary skipped; ${local})`);
	return hits.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	process.exitCode = main();
}
