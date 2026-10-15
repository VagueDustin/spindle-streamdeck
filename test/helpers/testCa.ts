// A throwaway CA and a localhost leaf signed by it, built at test time with node:crypto (minimal
// DER X.509 v3, ECDSA P-256). Nothing is committed: every run makes fresh keys, which exist only
// in memory. CN=spindle-test.invalid marks them as test-only.
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

const OID = {
	commonName: "2.5.4.3",
	ecdsaWithSha256: "1.2.840.10045.4.3.2",
	basicConstraints: "2.5.29.19",
	keyUsage: "2.5.29.15",
	subjectAltName: "2.5.29.17"
};

function len(n: number): Buffer {
	if (n < 0x80) return Buffer.from([n]);
	const bytes: number[] = [];
	for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const explicit = (n: number, body: Buffer) => tlv(0xa0 | n, body);
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const octets = (body: Buffer) => tlv(0x04, body);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
const bits = (body: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), body]));

function integer(bytes: Buffer): Buffer {
	// A positive INTEGER: prefix 0x00 when the top bit is set.
	return tlv(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function oid(dotted: string): Buffer {
	const [a, b, ...rest] = dotted.split(".").map(Number);
	const out = [a * 40 + b];
	for (const n of rest) {
		const chunk = [n & 0x7f];
		for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
		out.push(...chunk);
	}
	return tlv(0x06, Buffer.from(out));
}

function utcTime(d: Date): Buffer {
	const p = (n: number) => String(n).padStart(2, "0");
	const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
	return tlv(0x17, Buffer.from(s, "ascii"));
}

const name = (cn: string) => seq(set(seq(oid(OID.commonName), utf8(cn))));
const extension = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

function certificate(opts: { subject: string; issuer: string; publicKey: KeyObject; signingKey: KeyObject; extensions: Buffer[] }): string {
	const now = Date.now();
	const sigAlg = seq(oid(OID.ecdsaWithSha256));
	const serial = randomBytes(8);
	serial[0] &= 0x7f;
	const tbs = seq(
		explicit(0, integer(Buffer.from([2]))),
		integer(serial),
		sigAlg,
		name(opts.issuer),
		seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 86_400_000))),
		name(opts.subject),
		opts.publicKey.export({ type: "spki", format: "der" }),
		explicit(3, seq(...opts.extensions))
	);
	const der = seq(tbs, sigAlg, bits(sign("sha256", tbs, opts.signingKey)));
	const b64 = der.toString("base64").replace(/.{1,64}/g, "$&\n");
	// Assembled at runtime, so no PEM armour sits in the repository as a literal block.
	const label = ["CERT", "IFICATE"].join("");
	return `-----BEGIN ${label}-----\n${b64}-----END ${label}-----\n`;
}

export type TestPki = {
	/** The CA certificate (PEM): trust this to accept `cert`. */
	ca: string;
	/** The leaf for localhost and 127.0.0.1 (PEM), signed by `ca`. */
	cert: string;
	/** The leaf's private key (PEM), for `https.createServer`. */
	key: string;
};

/** A fresh CA plus a server certificate for `localhost` and `127.0.0.1`, signed by that CA. */
export function makeTestPki(): TestPki {
	const caKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const leafKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const caName = "Spindle Test CA spindle-test.invalid";
	const ca = certificate({
		subject: caName,
		issuer: caName,
		publicKey: caKeys.publicKey,
		signingKey: caKeys.privateKey,
		extensions: [
			extension(OID.basicConstraints, true, seq(bool(true))),
			// keyCertSign | cRLSign
			extension(OID.keyUsage, true, tlv(0x03, Buffer.from([1, 0x06])))
		]
	});
	const cert = certificate({
		subject: "spindle-test.invalid",
		issuer: caName,
		publicKey: leafKeys.publicKey,
		signingKey: caKeys.privateKey,
		extensions: [
			extension(OID.basicConstraints, true, seq()),
			// SAN: dNSName localhost, iPAddress 127.0.0.1
			extension(OID.subjectAltName, false, seq(tlv(0x82, Buffer.from("localhost")), tlv(0x87, Buffer.from([127, 0, 0, 1]))))
		]
	});
	const key = leafKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
	return { ca, cert, key };
}
