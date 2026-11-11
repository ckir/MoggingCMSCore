import { ValidationError } from "../errors.js";

/** Canonicalize a BCP 47 tag: language lower, Script Title, REGION upper, variants lower. */
export function normalizeLocale(code: string): string {
  if (typeof code !== "string") throw new ValidationError(`Malformed locale: ${String(code)}`);
  const parts = code.split("-");
  const bad = () => new ValidationError(`Malformed locale: "${code}"`);
  const lang = parts[0] ?? "";
  if (!/^[A-Za-z]{2,3}$/.test(lang)) throw bad();
  const out = [lang.toLowerCase()];
  let i = 1;
  if (i < parts.length && /^[A-Za-z]{4}$/.test(parts[i]!)) {
    const s = parts[i]!;
    out.push(s[0]!.toUpperCase() + s.slice(1).toLowerCase());
    i++;
  }
  if (i < parts.length && /^([A-Za-z]{2}|[0-9]{3})$/.test(parts[i]!)) {
    out.push(parts[i]!.toUpperCase());
    i++;
  }
  while (i < parts.length && /^([A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3})$/.test(parts[i]!)) {
    out.push(parts[i]!.toLowerCase());
    i++;
  }
  if (i < parts.length) throw bad();
  return out.join("-");
}
