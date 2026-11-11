import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { ValidationError } from "../errors.js";

/** SHA-256 hex over the RFC 8785 canonical JSON encoding of `value`. */
export function hashValue(value: unknown): string {
  const canonical = canonicalize(value);
  if (canonical === undefined) throw new ValidationError("value is not JSON-serializable");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
