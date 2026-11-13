import { getSyncState, listDocuments } from "@mogging/core";
import type { Ctx, SyncStateKind, SyncStateRow } from "@mogging/core";
import { UsageError } from "../types.js";
import type { CommandSpec } from "../types.js";

export type StatusRow = SyncStateRow & { collection: string; slug: string | null };

/** The order the count lines list the states in. */
const KINDS: SyncStateKind[] = ["current", "stale", "missing", "untracked", "orphaned"];

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `docId -> slug` of one collection from every `listDocuments` page (200 a page: `listDocuments` has no maximum). */
async function slugsOf(ctx: Ctx, collection: string): Promise<Map<string, string | null>> {
  const slugs = new Map<string, string | null>();
  let after: string | undefined;
  for (;;) {
    const page = await listDocuments(ctx, { collection, limit: 200, ...(after === undefined ? {} : { after }) });
    for (const item of page.items) slugs.set(item.id, item.slug);
    if (page.next === null) return slugs;
    after = page.next;
  }
}

const labelOf = (row: StatusRow): string => `${row.collection}/${row.slug ?? row.docId}`;

export const statusSpec: CommandSpec = {
  name: "status",
  summary: "show the translation sync state of every localized field",
  usage: "mogging status [<collection>] [--locale <l>] [--json] [--config <path>] [--database-url <url>]",
  options: { locale: { type: "string" } },
  project: "full",
  arity: [0, 1],
  async run(env) {
    const { ctx } = env.project;
    const only = env.positionals[0];
    if (only !== undefined && !ctx.config.collections.some((c) => c.name === only)) {
      throw new UsageError(`unknown collection "${only}" (declared: ${ctx.config.collections.map((c) => c.name).join(", ")})`);
    }
    const locale = typeof env.flags.locale === "string" ? env.flags.locale : undefined;

    // getSyncState rows carry no collection, so it runs once per collection.
    const rows: StatusRow[] = [];
    for (const col of ctx.config.collections) {
      if (only !== undefined && col.name !== only) continue;
      const found = await getSyncState(ctx, { collection: col.name, ...(locale === undefined ? {} : { locale }) });
      if (found.length === 0) continue;
      const slugs = await slugsOf(ctx, col.name);
      for (const row of found) rows.push({ ...row, collection: col.name, slug: slugs.get(row.docId) ?? null });
    }
    rows.sort(
      (a, b) =>
        compare(a.collection, b.collection) || compare(labelOf(a), labelOf(b)) || compare(a.docId, b.docId) ||
        compare(a.locale, b.locale) || compare(a.field, b.field),
    );

    const lines: string[] = [];
    for (const loc of [...new Set(rows.map((r) => r.locale))].sort(compare)) {
      const mine = rows.filter((r) => r.locale === loc);
      for (const kind of KINDS) {
        const n = mine.filter((r) => r.state === kind).length;
        if (n > 0) lines.push(`${loc}: ${n} ${kind}`);
      }
      for (const row of mine) if (row.state !== "current") lines.push(`${labelOf(row)} ${row.field} ${row.state}`);
    }

    // One `track` suggestion per document and locale that has untracked fields (spec 6.4).
    const untracked = new Map<string, { label: string; locale: string; fields: string[] }>();
    for (const row of rows) {
      if (row.state !== "untracked") continue;
      const key = `${row.collection}\0${row.docId}\0${row.locale}`;
      const entry = untracked.get(key) ?? { label: labelOf(row), locale: row.locale, fields: [] };
      entry.fields.push(row.field);
      untracked.set(key, entry);
    }
    for (const u of untracked.values()) {
      lines.push(`run: mogging track ${u.label} --locale ${u.locale} --fields ${u.fields.join(",")}`);
    }

    return { data: { rows }, lines };
  },
};
