import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { ValidationError } from "../errors.js";

/**
 * SHA-256 hex over the RFC 8785 canonical JSON encoding of `value`. Callers pass a value already
 * normalized by `normalizeValue`; the result is the storage contract for translation sync and must
 * not change without a plan to re-track or re-translate existing content.
 *
 * @param value JSON-serializable normalized value.
 * @returns a 64-character lower-case hex digest.
 * @throws {ValidationError} when the value cannot be canonicalized (for example `undefined`).
 * @remarks Pure and synchronous. RFC 8785 makes object key order and numeric representation
 * canonical, so equal normalized values hash equally regardless of insertion order.
 */
export function hashValue(value: unknown): string {
  const canonical = canonicalize(value);
  if (canonical === undefined) throw new ValidationError("value is not JSON-serializable");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
