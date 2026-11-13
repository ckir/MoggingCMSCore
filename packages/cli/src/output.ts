import type { LicenceState } from "@mogging/core";
import type { CommandResult, LicenceInfo } from "./types.js";

/**
 * `scheme://user:pass@host`: the password is everything after the first `:` of the userinfo up to the last `@`
 * before a `/`, whitespace or a quote. Stopping at quotes keeps a serialized JSON document parseable; stopping at
 * `/` leaves `http://host:8080/x@y` alone.
 */
const URL_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^\s:@/"'\\]*:)[^\s/"'\\]*@/gi;

export function maskSecrets(text: string): string {
  return text.replace(URL_PASSWORD, "$1***@");
}

/**
 * Makes stored or AI-derived text safe to print: every C0 control except `\n` and `\t`, DEL and the C1 range becomes a
 * visible escape (`\x1b`, `\x0d`, `\x7f`; `\u0085` for C1), so a terminal never acts on it (conceal, cursor moves,
 * a bare `\r` that overwrites the line). Display only: it is never applied to `--json` data or to edit-file text.
 */
export function escapeControl(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => {
    const code = c.charCodeAt(0);
    return code >= 0x80 && code <= 0x9f ? `\\u${code.toString(16).padStart(4, "0")}` : `\\x${code.toString(16).padStart(2, "0")}`;
  });
}

/** Left-aligned columns padded to the longest cell, separated by two spaces; no trailing whitespace. */
export function table(rows: string[][], header?: string[]): string[] {
  const all = header === undefined ? rows : [header, ...rows];
  const widths: number[] = [];
  for (const row of all) row.forEach((cell, i) => void (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return all.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd());
}

export function describeError(err: unknown): { code: string; message: string } {
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    code?: unknown; name?: unknown; message?: unknown; errors?: unknown;
  };
  const isObject = typeof err === "object" && err !== null;
  const code = typeof e.code === "string" ? e.code : typeof e.name === "string" ? e.name : "Error";
  let message = isObject ? (typeof e.message === "string" ? e.message : "") : String(err);
  if (message === "" && Array.isArray(e.errors)) {
    message = e.errors
      .map((sub: unknown) => (sub as { message?: unknown } | null)?.message)
      .filter((m): m is string => typeof m === "string" && m !== "")
      .join("; ");
  }
  if (message === "") message = code;
  return { code: maskSecrets(code), message: maskSecrets(message) };
}

export function licenceInfo(state: LicenceState): LicenceInfo {
  return {
    state: state.state,
    daysLeft: state.daysLeft ?? null,
    warn: state.warn,
    plan: state.payload?.plan ?? null,
    licensee: state.payload?.licensee ?? null,
    keyError: state.keyError ?? null,
  };
}

/** The licence lines for stderr (spec 12.3, 12.4). */
export function licenceLines(info: LicenceInfo): string[] {
  const lines: string[] = [];
  if (info.keyError !== null) {
    lines.push(`warning: licence key rejected (${info.keyError}); running as ${info.state}`);
  }
  if (info.state === "evaluation") {
    lines.push(`${info.warn ? "warning: " : ""}MoggingCMS evaluation: ${info.daysLeft} days left`);
  } else if (info.state === "expired") {
    lines.push(
      "warning: MoggingCMS evaluation has ended: reads keep working, but content updates, compiles and publishing are paused until a licence key is set",
    );
  } else if (info.plan === "noncommercial") {
    lines.push("MoggingCMS noncommercial licence: commercial use is not permitted");
    if (info.licensee !== null) lines.push(`licensee: ${info.licensee}`);
  }
  return lines;
}

type Failure = { code: string; message: string };

/**
 * The `--json` document. A command result gives `{ ok, partial, data, [error], licence }` (`ok` for exit 0 and 4,
 * `partial` exactly for 4); a throw gives `{ ok: false, error, licence }` with no `data` and no `partial`.
 * A result's own `licence` wins over `licence`, the opened project's.
 */
export function jsonDocument(
  input: { result: CommandResult; licence: LicenceInfo | null } | { error: Failure; licence: LicenceInfo | null },
): Record<string, unknown> {
  if (!("result" in input)) return { ok: false, error: input.error, licence: input.licence };
  const { result } = input;
  const exitCode = result.exitCode ?? 0;
  return {
    ok: exitCode === 0 || exitCode === 4,
    partial: exitCode === 4,
    data: result.data,
    ...(exitCode === 1 && result.error !== undefined ? { error: result.error } : {}),
    licence: result.licence ?? input.licence,
  };
}
