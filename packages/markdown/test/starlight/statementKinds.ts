/** The six kinds of write transaction the Starlight import runs. */
export type TxKind =
  | "source"
  | "locale-dayone-save-publish"
  | "locale-tracked-save-publish"
  | "locale-dayone-save-only"
  | "locale-tracked-save-only"
  | "locale-publish-only";

/** Collapses every run of whitespace to one space and trims, so a multi-line statement matches a one-line pattern. */
const norm = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Splits a statement log at each `begin` .. `commit` pair without classifying. Statements outside a transaction are
 * ignored.
 *
 * @param statements - The statement texts in execution order, as `capturingSql` records them.
 * @returns One entry per transaction: its whitespace-normalized statements, `begin` and `commit` included.
 * @throws Error when the log ends inside a transaction.
 */
export function splitTransactions(statements: string[]): string[][] {
  const out: string[][] = [];
  let open: string[] | null = null;
  for (const raw of statements) {
    const text = norm(raw);
    if (open === null) {
      if (text.toLowerCase() === "begin") open = [text];
      continue;
    }
    open.push(text);
    if (text.toLowerCase() === "commit") {
      out.push(open);
      open = null;
    }
  }
  if (open !== null) throw new Error("the statement log ends inside a transaction");
  return out;
}

/** The row lock on the `documents` row that `saveDraft` and `publish` take first (`select ... for update`). */
export const ROW_LOCK = /^select id from documents where id = \$1 and deleted_at is null for update$/;
/** The database-clock read of `publish`. */
export const CLOCK_READ = /clock_timestamp\(\)/;
/** The collection slug lock (a transaction-scoped advisory lock). */
export const SLUG_LOCK = /pg_advisory_xact_lock/;

/**
 * The index of the first statement matching `pattern`, or -1.
 *
 * @param tx - The statements of one transaction.
 * @param pattern - The pattern to look for.
 * @returns The index, or -1 when no statement matches.
 */
export const firstIndex = (tx: string[], pattern: RegExp): number => tx.findIndex((t) => pattern.test(t));

/**
 * Splits a statement log at each `begin` .. `commit` pair and classifies each transaction by content. A transaction
 * that inserts into `documents` is `source`; otherwise one that inserts into `document_localized` and flips a row to
 * `set state = 'PUBLISHED'` is a save and publish, tracked when it reads the source head
 * (`select data from document_localized where doc_id = $1 and locale = $2 and is_head_published`, the tracked
 * source-head read of `saveDraft.ts`) and day-one when it does not; one with the insert but no flip is save-only
 * (same tracked or day-one split); one with the flip but no insert is publish-only. Statements outside a transaction
 * are ignored. A transaction that fits none of these throws, so a classification gap cannot pass unnoticed.
 *
 * @param statements - The statement texts in execution order, as `capturingSql` records them.
 * @returns One entry per transaction, in order: its kind and its whitespace-normalized statements, `begin` and `commit` included.
 * @throws Error when a transaction fits none of the six kinds or the log ends inside a transaction.
 */
export function transactionsOf(statements: string[]): Array<{ kind: TxKind; statements: string[] }> {
  return splitTransactions(statements).map((tx) => ({ kind: classify(tx), statements: tx }));
}

function classify(tx: string[]): TxKind {
  const has = (needle: string): boolean => tx.some((t) => t.includes(needle));
  if (has("insert into documents")) return "source";
  const inserts = has("insert into document_localized");
  const flips = has("set state = 'PUBLISHED'");
  const tracked = has("select data from document_localized where doc_id = $1 and locale = $2 and is_head_published");
  if (inserts && flips) return tracked ? "locale-tracked-save-publish" : "locale-dayone-save-publish";
  if (inserts) return tracked ? "locale-tracked-save-only" : "locale-dayone-save-only";
  if (flips) return "locale-publish-only";
  throw new Error(`unclassified transaction:\n${tx.join("\n")}`);
}
