import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { LicenceError } from "../errors.js";
import { PUBLIC_KEYS } from "./publicKey.js";

/**
 * Signed licence payload (spec 12.2). `limits` is reserved: v0.1 carries it through unchanged and never judges its
 * values, so an old engine always verifies a newer key with limit kinds it does not know.
 */
export type LicencePayload = {
  licensee: string;
  license_id: string;
  expiry: string; // ISO date YYYY-MM-DD, valid through 23:59:59.999 UTC of that date
  plan: "solo" | "noncommercial" | string;
  limits?: Record<string, unknown>;
};

const PREFIX = "mog1";
const SIGNATURE_BYTES = 64; // Ed25519
const B64U = /^[A-Za-z0-9_-]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const invalid = (why: string) => new LicenceError("LICENCE_INVALID", `Licence key is invalid: ${why}`);

/** Strict base64url: alphabet only, no padding, canonical (re-encodes to the same text). */
function decodeB64u(s: string, what: string): Buffer {
  if (!B64U.test(s)) throw invalid(`${what} is not base64url`);
  const buf = Buffer.from(s, "base64url");
  if (buf.length === 0 || buf.toString("base64url") !== s) throw invalid(`${what} is not base64url`);
  return buf;
}

/** End of the expiry date in UTC (exclusive), or undefined for a malformed or impossible date. */
function expiryEndMs(expiry: string): number | undefined {
  const m = DATE.exec(expiry);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const start = Date.UTC(y, mo - 1, d);
  const back = new Date(start);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return undefined;
  return start + 86_400_000;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Shape check of an untrusted payload; returns a fresh object with the known fields only. */
function toPayload(v: unknown): LicencePayload {
  if (!isPlainObject(v)) throw invalid("payload is not an object");
  for (const k of ["licensee", "license_id", "expiry", "plan"] as const) {
    if (typeof v[k] !== "string") throw invalid(`payload field "${k}" is missing or not a string`);
  }
  const expiry = v.expiry as string;
  if (expiryEndMs(expiry) === undefined) throw invalid('payload field "expiry" is not a YYYY-MM-DD date');
  const out: LicencePayload = {
    licensee: v.licensee as string, license_id: v.license_id as string, expiry, plan: v.plan as string,
  };
  // Absent or null = no limits. Otherwise only the container is checked: values are a later plan's business.
  if (v.limits !== undefined && v.limits !== null) {
    if (!isPlainObject(v.limits)) throw invalid('payload field "limits" must be an object');
    out.limits = v.limits;
  }
  return out;
}

/**
 * Signs a payload into a `mog1.<payload>.<signature>` token (signing tool only; not exported from the SDK).
 * The signature covers the exact payload bytes that are base64url-encoded into the token.
 */
export function encodeKey(payload: LicencePayload, privateKeyPem: string): string {
  const checked = toPayload(payload);
  const bytes = Buffer.from(JSON.stringify(checked), "utf8");
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new LicenceError("LICENCE_INVALID", "Signing key is not an Ed25519 private key");
  const signature = sign(null, bytes, key);
  return `${PREFIX}.${bytes.toString("base64url")}.${signature.toString("base64url")}`;
}

function verifiesWithAny(payload: Buffer, signature: Buffer, pems: readonly string[]): boolean {
  for (const pem of pems) {
    let key: KeyObject;
    try {
      key = createPublicKey(pem);
    } catch {
      continue; // an unusable entry never verifies anything
    }
    if (key.asymmetricKeyType !== "ed25519") continue;
    try {
      if (verify(null, payload, key, signature)) return true;
    } catch {
      // treated as a non-match
    }
  }
  return false;
}

/**
 * Verifies a licence token offline (spec 12.2). Accepted when ANY listed Ed25519 public key verifies the
 * signature over the raw payload bytes; the payload is parsed only after that. Throws `LicenceError`
 * `LICENCE_INVALID` (malformed, bad signature, no usable key) or `LICENCE_EXPIRED` (past the end of the
 * expiry date in UTC); never any other error type. The token is never echoed.
 */
export function verifyKey(
  token: string,
  publicKeyPems: string | readonly string[] = PUBLIC_KEYS,
  now: Date = new Date(),
): LicencePayload {
  try {
    if (typeof token !== "string") throw invalid("not a string");
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== PREFIX) throw invalid("not a mog1 token");
    const payloadBytes = decodeB64u(parts[1]!, "payload");
    const signature = decodeB64u(parts[2]!, "signature");
    if (signature.length !== SIGNATURE_BYTES) throw invalid("signature has the wrong length");
    const pems = typeof publicKeyPems === "string" ? [publicKeyPems] : [...publicKeyPems];
    if (pems.length === 0) throw invalid("no public key is configured");
    if (!verifiesWithAny(payloadBytes, signature, pems)) throw invalid("signature does not verify");

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
    } catch {
      throw invalid("payload is not JSON");
    }
    const payload = toPayload(parsed);
    if (now.getTime() >= expiryEndMs(payload.expiry)!) {
      throw new LicenceError("LICENCE_EXPIRED", `Licence key expired on ${payload.expiry}`);
    }
    return payload;
  } catch (e) {
    if (e instanceof LicenceError) throw e;
    throw invalid("could not be verified");
  }
}
