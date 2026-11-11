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
