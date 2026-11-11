import { expect, test } from "vitest";
import {
  boolean, dateTime, list, number, object, reference, richText, slug, text, ValidationError,
} from "../src/index.js";
import { hashValue } from "../src/values/hash.js";
import { isEmptyValue, normalizeValue, stripTopLevelNulls } from "../src/values/normalize.js";

test("dateTime normalizes to UTC with milliseconds", () => {
  expect(normalizeValue(dateTime(), "2026-11-11T08:00:00Z")).toBe("2026-11-11T08:00:00.000Z");
  expect(normalizeValue(dateTime(), "2026-11-11T10:00:00+02:00")).toBe("2026-11-11T08:00:00.000Z");
});
test("text normalizes NFC so composed and decomposed hash equal", () => {
  const composed = "é";
  const decomposed = "é";
  expect(hashValue(composed)).not.toBe(hashValue(decomposed));
  expect(hashValue(normalizeValue(text(), composed))).toBe(hashValue(normalizeValue(text(), decomposed)));
});
test("hash is RFC 8785 canonical: key order does not matter", () => {
  expect(hashValue({ b: 1, a: [1, 2] })).toBe(hashValue({ a: [1, 2], b: 1 }));
});
test("number given as string is rejected", () => {
  expect(() => normalizeValue(number(), "3")).toThrow(ValidationError);
});
test("top-level null is stripped, nested null is kept", () => {
  expect(stripTopLevelNulls({ a: null, b: [1, null], c: { d: null } })).toEqual({ b: [1, null], c: { d: null } });
});
test("isEmptyValue is true for '' [] {} and false for 0 and false", () => {
  expect(isEmptyValue(text(), "")).toBe(true);
  expect(isEmptyValue(list(text()), [])).toBe(true);
  expect(isEmptyValue(object({}), {})).toBe(true);
  expect(isEmptyValue(richText(), { children: [] })).toBe(true);
  expect(isEmptyValue(number(), 0)).toBe(false);
  expect(isEmptyValue(boolean(), false)).toBe(false);
  expect(isEmptyValue(text(), "x")).toBe(false);
  expect(isEmptyValue(list(text()), [null])).toBe(false);
});
test("list with null elements round-trips unchanged", () => {
  const f = list(text());
  const v = ["a", null, "b"];
  expect(normalizeValue(f, v)).toEqual(v);
  expect(stripTopLevelNulls({ tags: normalizeValue(f, v) })).toEqual({ tags: v });
});
test("error messages carry the field path", () => {
  expect(() => normalizeValue(list(text()), ["a", "b", 3])).toThrow(/\[2\]/);
  const addr = object({ address: object({ zip: number() }) });
  expect(() => normalizeValue(addr, { address: { zip: "x" } })).toThrow(/address\.zip/);
  expect(() => normalizeValue(addr, { address: { zap: 1 } })).toThrow(/address\.zap/);
  expect(() => normalizeValue(addr, { address: { zip: "x" } })).toThrow(ValidationError);
});
test("slug lower-cases", () => {
  expect(normalizeValue(slug(), "Hello-World")).toBe("hello-world");
});
test("number rejects NaN and Infinity", () => {
  expect(() => normalizeValue(number(), NaN)).toThrow(ValidationError);
  expect(() => normalizeValue(number(), Infinity)).toThrow(ValidationError);
  expect(normalizeValue(number(), 3.5)).toBe(3.5);
});
test("boolean, reference, dateTime kind checks", () => {
  expect(() => normalizeValue(boolean(), "true")).toThrow(ValidationError);
  expect(() => normalizeValue(reference("posts"), 5)).toThrow(ValidationError);
  expect(normalizeValue(reference("posts"), "abc")).toBe("abc");
  expect(() => normalizeValue(dateTime(), "not a date")).toThrow(ValidationError);
  expect(normalizeValue(dateTime(), new Date("2026-11-11T08:00:00Z"))).toBe("2026-11-11T08:00:00.000Z");
});
test("richText NFC-normalizes strings recursively", () => {
  expect(normalizeValue(richText(), { children: [{ t: "é" }] })).toEqual({ children: [{ t: "é" }] });
});

test("nested object rejects prototype-named undeclared keys", () => {
  const f = object({ zip: number() });
  for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    expect(() => normalizeValue(f, JSON.parse(`{"${key}":1}`)), key).toThrow(ValidationError);
  }
});

// Pinned vectors: digests computed outside this code base (`printf '%s' <RFC 8785 canonical JSON> | sha256sum`),
// so a drift in the digest, the encoding or the canonicalisation cannot pass by changing code and fixture together.
test("hashValue matches pinned SHA-256 vectors over RFC 8785 canonical JSON", () => {
  expect(hashValue("Hello")).toBe("c25bf945aaff8fe16826d3c1ef117044d6cc1af8e0e9f0b4162308460a8207a7");
  expect(hashValue({ b: [true, null], a: 1 })).toBe("1cc69c7fa23616ca2ec3ee70d24390a6225c8832db8a4c814c7e0e7f942f8668");
  expect(hashValue(1.5)).toBe("9f29a130438b81170b92a42650f9a94291ecad60bd47af2a3886e75f7f728725");
  expect(hashValue([])).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
  // Near-miss distractor: the unquoted string is a different value.
  expect(hashValue("Hello")).not.toBe("185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969");
});
test("richText rejects NaN and Infinity nested inside the document, naming the path", () => {
  expect(() => normalizeValue(richText(), { children: [{ value: NaN }] }, "body")).toThrow(/body\.children\[0\]\.value.*non-finite/);
  expect(() => normalizeValue(richText(), { children: [{ value: Infinity }] }, "body")).toThrow(ValidationError);
  expect(normalizeValue(richText(), { children: [{ value: 2 }] }, "body")).toEqual({ children: [{ value: 2 }] });
});
