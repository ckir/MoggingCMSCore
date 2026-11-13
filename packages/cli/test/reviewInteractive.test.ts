import { existsSync, readFileSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { hashValue, migrate, recordAiDraft, rejectDraft } from "@mogging/core";
import { markdownToTree } from "@mogging/markdown";
import type { Sql } from "postgres";
import { run } from "../src/run.js";
import type { Deps } from "../src/types.js";
import { withTestDb } from "./db.js";
import { aiDraft, connectionOver, coreCtx, DAY, publishedDoc, setFirstMigration, testDeps } from "./fixtures.js";

vi.setConfig({ testTimeout: 20_000 });

const MENU = "[a]pprove [r]eject [e]dit [s]kip [q]uit";
const POST = "[a]pprove [s]kip";
const W1 = 'glossary: "Intro", expected "Einführung"';
const W2 = "tone: too formal";
const ack = (w: string) => `acknowledge "${w}"? [y/n]`;
const SUMMARY = (a: number, r: number, s: number, c: number, f: number) =>
  `approved ${a}, rejected ${r}, skipped ${s}, conflicted ${c}, failed ${f}`;

const withDb = (fn: (sql: Sql) => Promise<void>) =>
  withTestDb(async (sql) => {
    await migrate(sql);
    await fn(sql);
  });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const prov = (fieldPath: string, warnings: string[] = []) => ({
  fieldPath, modelId: "m1", promptVersion: "p1", promptTokens: 10, completionTokens: 20, costMicros: 300, warnings,
});

/** A DRAFT_AI head of `fields` with one provenance row per field (copy of the helper in review.test.ts); returns its version. */
async function draftWith(
  sql: Sql, docId: string, locale: string, fields: Record<string, unknown>, warned: Record<string, string[]> = {},
): Promise<number> {
  const hashes: Record<string, string> = { title: hashValue("Intro"), body: hashValue("Hello") };
  const result = await recordAiDraft(coreCtx(sql), {
    docId, locale, fields, sourceVersion: 1,
    sourceHashes: Object.fromEntries(Object.keys(fields).map((k) => [k, hashes[k]!])),
    provenance: Object.keys(fields).map((k) => prov(k, warned[k] ?? [])),
  });
  if (!("version" in result)) throw new Error(`setup: the AI draft was cancelled (${result.cancelled})`);
  return result.version;
}

const rowsOf = (sql: Sql, docId: string, locale = "de") =>
  sql`select version, state, is_head_draft, data from document_localized
    where doc_id = ${docId} and locale = ${locale} order by version`;

async function head(sql: Sql, docId: string, locale = "de") {
  return (await rowsOf(sql, docId, locale)).find((r) => r.is_head_draft === true);
}

const provenanceOf = (sql: Sql, docId: string, version: number, locale = "de") =>
  sql`select field_path, edited, acknowledged_warnings, discard_reason, model_id from content_provenance
    where doc_id = ${docId} and locale = ${locale} and version = ${version} order by field_path nulls last, id`;

type Session = {
  t: ReturnType<typeof testDeps>;
  stdin: PassThrough;
  exit: Promise<number>;
  output(): string;
  /** Waits until `text` was printed after the previous `expect`, or rejects with the captured output. */
  expect(text: string): Promise<void>;
  send(line: string): void;
  answer(prompt: string, line: string): Promise<void>;
  end(): void;
};

const sessions: Session[] = [];
const seen: string[] = []; // every edit file the editor stub was given
const problems: string[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) {
    s.end();
    await s.exit;
  }
  for (const p of seen.splice(0)) rmSync(dirname(p), { recursive: true, force: true });
  expect(problems.splice(0)).toEqual([]);
});

/** An editor stub that checks the edit file's mode and location, then lets `fn` rewrite it. */
function editor(fn: (path: string) => void | Promise<void>): Deps["editor"] {
  return async (file) => {
    seen.push(file);
    if ((statSync(file).mode & 0o777) !== 0o600) problems.push(`mode of ${file} is not 0600`);
    if (dirname(dirname(file)) !== tmpdir()) problems.push(`${file} is not in a directory made under os.tmpdir()`);
    await fn(file);
  };
}

const edit = (from: string, to: string) => (path: string) => writeFileSync(path, readFileSync(path, "utf8").replace(from, to));

function start(
  sql: Sql, args: string[],
  opts: { editor?: Deps["editor"]; signal?: AbortSignal; onOut?: (s: string) => void; end?: () => Promise<void> } = {},
): Session {
  const t = testDeps(sql, {
    ...(opts.editor === undefined ? {} : { editor: opts.editor }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    connect: () => connectionOver(sql, opts.end),
  });
  const stdin = new PassThrough();
  t.io.stdin = stdin;
  t.io.isTTY = true;
  const write = t.io.out;
  t.io.out = (s) => {
    write(s);
    opts.onOut?.(s);
  };
  let cursor = 0;
  const session: Session = {
    t, stdin,
    exit: run(["review", ...args], t),
    output: () => t.stdout(),
    async expect(text) {
      const deadline = Date.now() + 4000;
      for (;;) {
        const at = t.stdout().indexOf(text, cursor);
        if (at >= 0) {
          cursor = at + text.length;
          return;
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(text)}\nstdout:\n${t.stdout()}\nstderr:\n${t.stderr()}`);
        await sleep(5);
      }
    },
    send: (line) => void stdin.write(`${line}\n`),
    async answer(prompt, line) {
      await session.expect(prompt);
      session.send(line);
    },
    end: () => void stdin.end(),
  };
  sessions.push(session);
  return session;
}

const count = (text: string, part: string) => text.split(part).length - 1;

describe("interactive review", () => {
  test("a approves the first pair and s skips the second; there is no approve-all key", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      await draftWith(sql, docId, "fr", { title: "Introduction" });
      const s = start(sql, ["--collection", "docs"]);
      await s.answer(MENU, "a");
      await s.answer(MENU, "s");
      expect(await s.exit).toBe(0);
      expect(s.output()).toMatch(/approved docs\/intro de v\d+/);
      expect(s.output()).toContain(SUMMARY(1, 0, 1, 0, 0));
      expect((await head(sql, docId, "de"))!.state).toBe("APPROVED");
      expect((await head(sql, docId, "fr"))!.state).toBe("DRAFT_AI");
      const v = (await head(sql, docId, "de"))!.version as number;
      expect((await provenanceOf(sql, docId, v)).map((r) => r.acknowledged_warnings)).toEqual([null]);
    });
  });

  test("--locale scopes the review, with a document and without", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      await draftWith(sql, docId, "fr", { title: "Introduction" });
      for (const args of [["docs/intro", "--locale", "fr"], ["--locale", "fr"]]) {
        const s = start(sql, args);
        await s.answer(MENU, "s");
        expect(await s.exit).toBe(0);
        expect(count(s.output(), MENU)).toBe(1);
        expect(s.output()).toContain("docs/intro fr");
        expect(s.output()).not.toContain("docs/intro de");
      }
    });
  });

  test("q stops the review with the summary", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      await draftWith(sql, docId, "fr", { title: "Introduction" });
      const s = start(sql, []);
      await s.answer(MENU, "q");
      expect(await s.exit).toBe(0);
      expect(count(s.output(), MENU)).toBe(1);
      expect(s.output()).toContain(SUMMARY(0, 0, 0, 0, 0));
    });
  });

  test("r asks for a reason and rejects the draft", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      const v = await draftWith(sql, docId, "de", { title: "Einleitung" });
      const s = start(sql, ["docs/intro"]);
      await s.answer(MENU, "r");
      await s.answer("reason (optional", "too formal");
      expect(await s.exit).toBe(0);
      expect(s.output()).toContain(`rejected docs/intro de v${v}`);
      expect(s.output()).toContain(SUMMARY(0, 1, 0, 0, 0));
      expect(await head(sql, docId)).toBeUndefined();
      const marker = (await provenanceOf(sql, docId, v)).find((r) => r.model_id === "human:reject");
      expect(marker!.discard_reason).toBe("too formal");
    });
  });

  test("nothing to review exits 0, for a document and for the whole project", async () => {
    await withDb(async (sql) => {
      await publishedDoc(sql);
      for (const args of [["docs/intro"], []]) {
        const s = start(sql, args);
        expect(await s.exit).toBe(0);
        expect(s.output()).toContain("nothing to review");
        expect(s.output()).not.toContain(MENU);
      }
    });
  });
});

describe("interactive review: the terminal and the input", () => {
  test("without a terminal it exits 2 before connecting and writes nothing to stdout", async () => {
    await withDb(async (sql) => {
      for (const args of [["review"], ["review", "docs/intro"]]) {
        const t = testDeps(sql, { connect: () => { throw new Error("connected"); } });
        expect(await run(args, t)).toBe(2);
        expect(t.stdout()).toBe("");
        expect(t.stderr()).toContain("interactive review needs a terminal; use review list|show|approve|reject or --approve-clean");
      }
    });
  });

  test("end of input before the first answer stops without approving and closes the project", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      let ends = 0;
      const s = start(sql, [], { end: async () => void (ends += 1) });
      await s.expect(MENU);
      s.end();
      expect(await s.exit).toBe(0);
      expect(s.output()).toContain(SUMMARY(0, 0, 0, 0, 0));
      expect((await head(sql, docId))!.state).toBe("DRAFT_AI");
      expect(ends).toBe(1);
    });
  });

  test("end of input after the second answer stops before the third", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      await draftWith(sql, docId, "fr", { title: "Introduction" });
      const s = start(sql, []);
      await s.answer(MENU, "s");
      await s.expect(MENU);
      s.end();
      expect(await s.exit).toBe(0);
      expect(s.output()).toContain(SUMMARY(0, 0, 1, 0, 0));
      expect((await head(sql, docId, "fr"))!.state).toBe("DRAFT_AI");
    });
  });

  test("a line written before the first prompt, then end of input, approves nothing", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      const s = start(sql, []);
      s.send("a");
      s.end();
      expect(await s.exit).toBe(0);
      expect((await head(sql, docId))!.state).toBe("DRAFT_AI");
    });
  });

  test("a line written before the first prompt does not answer it (the input stays open)", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      const s = start(sql, []);
      s.send("a");
      await s.expect(MENU);
      await sleep(150);
      expect((await head(sql, docId))!.state).toBe("DRAFT_AI");
      expect(s.output()).not.toMatch(/approved docs/);
      s.end();
      expect(await s.exit).toBe(0);
    });
  });

  test("a line typed while the editor ran does not answer the post-edit prompt", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      let typed: Session | undefined;
      const s = start(sql, [], {
        editor: editor((path) => {
          edit("Einleitung", "Neu")(path);
          typed!.stdin.write("a\n");
        }),
      });
      typed = s;
      await s.answer(MENU, "e");
      await s.expect(POST);
      await sleep(150);
      expect((await head(sql, docId))!.state).toBe("DRAFT_AI");
      s.send("s");
      expect(await s.exit).toBe(0);
      expect(s.output()).toContain(SUMMARY(0, 0, 1, 0, 0));
    });
  });

  test("a signal aborted after the first answer stops before the second pair, with the summary", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      await draftWith(sql, docId, "fr", { title: "Introduction" });
      const controller = new AbortController();
      const s = start(sql, [], {
        signal: controller.signal,
        onOut: (text) => {
          if (text.includes("skipped docs/intro de")) controller.abort(); // synchronously, as the first pair ends
        },
      });
      await s.answer(MENU, "s");
      expect(await s.exit).toBe(0);
      expect(count(s.output(), MENU)).toBe(1);
      expect(s.output()).not.toContain("docs/intro fr");
      expect(s.output()).toContain(SUMMARY(0, 0, 1, 0, 0));
    });
  });
});

describe("interactive review: warnings (D-warn)", () => {
  const warned = (sql: Sql, docId: string) =>
    draftWith(sql, docId, "de", { title: "Einleitung", body: "Hallo" }, { title: [W1, W2], body: [W1] });

  test("a asks once per distinct warning; n leaves the draft pending, y for each approves and records them", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await warned(sql, docId);
      const s = start(sql, ["docs/intro"]);
      await s.answer(MENU, "a");
      await s.answer(ack(W1), "n");
      await s.expect(MENU); // back at the menu it came from
      expect((await head(sql, docId))!.state).toBe("DRAFT_AI");
      s.send("a");
      await s.answer(ack(W1), "y");
      await s.answer(ack(W2), "y");
      expect(await s.exit).toBe(0);
      expect(count(s.output(), ack(W1))).toBe(2); // once per pass, though two fields carry it
      expect(count(s.output(), ack(W2))).toBe(1); // the first pass stopped at n
      const approved = (await head(sql, docId))!;
      expect(approved.state).toBe("APPROVED");
      const rows = await provenanceOf(sql, docId, approved.version as number);
      expect(rows.map((r) => r.acknowledged_warnings)).toEqual([[W1, W2], [W1, W2]]);
    });
  });

  test("end of input at an acknowledgement approves nothing", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await warned(sql, docId);
      const s = start(sql, ["docs/intro"]);
      await s.answer(MENU, "a");
      await s.expect(ack(W1));
      s.end();
      expect(await s.exit).toBe(0);
      expect((await head(sql, docId))!.state).toBe("DRAFT_AI");
    });
  });

  test("e then a asks the acknowledgement before approving with the edit", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      const v = await warned(sql, docId);
      const s = start(sql, ["docs/intro"], { editor: editor(edit("Einleitung", "Neue Einleitung")) });
      await s.answer(MENU, "e");
      await s.answer(POST, "a");
      await s.answer(ack(W1), "y");
      await s.answer(ack(W2), "y");
      expect(await s.exit).toBe(0);
      const approved = (await head(sql, docId))!;
      expect(approved.state).toBe("APPROVED");
      expect((approved.data as { title: string }).title).toBe("Neue Einleitung");
      const rows = await provenanceOf(sql, docId, approved.version as number);
      expect(rows.find((r) => r.field_path === "title")!.edited).toBe(true);
      expect(rows.find((r) => r.field_path === "body")!.edited).toBe(false);
      expect(rows.every((r) => (r.acknowledged_warnings as string[]).length === 2)).toBe(true);
      expect(v).toBeLessThan(approved.version as number);
      expect(existsSync(seen[0]!)).toBe(false);
    });
  });

  test("e, a, n returns to the post-edit prompt with the edit file still there; s keeps the draft pending and removes the file", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await warned(sql, docId);
      const s = start(sql, ["docs/intro"], { editor: editor(edit("Einleitung", "Neu")) });
      await s.answer(MENU, "e");
      await s.answer(POST, "a");
      await s.answer(ack(W1), "n");
      await s.expect(POST);
      expect(existsSync(seen[0]!)).toBe(true);
      s.send("s");
      expect(await s.exit).toBe(0);
      expect((await head(sql, docId))!.state).toBe("DRAFT_AI");
      expect(existsSync(seen[0]!)).toBe(false);
      expect(existsSync(dirname(seen[0]!))).toBe(false);
    });
  });
});

describe("interactive review: the edit step", () => {
  test("e stores the edited text and marks the field edited; the edit file and its directory are removed", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      const s = start(sql, ["docs/intro"], { editor: editor(edit("Einleitung", "Neue Einleitung")) });
      await s.answer(MENU, "e");
      await s.expect(POST);
      expect(s.output()).toContain("Neue Einleitung"); // the edited review is shown before anything is approved
      expect((await head(sql, docId))!.state).toBe("DRAFT_AI"); // edit never approves by itself
      s.send("a");
      expect(await s.exit).toBe(0);
      const approved = (await head(sql, docId))!;
      expect(approved.data).toEqual({ title: "Neue Einleitung" });
      expect((await provenanceOf(sql, docId, approved.version as number)).map((r) => r.edited)).toEqual([true]);
      expect(existsSync(seen[0]!)).toBe(false);
      expect(existsSync(dirname(seen[0]!))).toBe(false);
    });
  });

  test("an MDX body keeps mode mdx", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { body: markdownToTree("Hallo", { mode: "mdx" }) });
      const s = start(sql, ["docs/intro"], { editor: editor(edit("Hallo", "Hallo Welt")) });
      await s.answer(MENU, "e");
      await s.answer(POST, "a");
      expect(await s.exit).toBe(0);
      const approved = (await head(sql, docId))!;
      expect((approved.data as { body: unknown }).body).toEqual(markdownToTree("Hallo Welt", { mode: "mdx" }));
      expect((approved.data as { body: { mode: string } }).body.mode).toBe("mdx");
    });
  });

  test("a refused edit file prints the error and the kept path, shows the menu again; a fresh e writes a fresh file", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      let calls = 0;
      const s = start(sql, ["docs/intro"], {
        editor: editor((path) => {
          calls += 1;
          if (calls === 1) writeFileSync(path, "stray text\n=== title ===\nx\n");
          else edit("Einleitung", "Neu")(path);
        }),
      });
      await s.answer(MENU, "e");
      await s.expect("text before its first section header");
      await s.expect(`edit file kept: ${seen[0]}`);
      expect(existsSync(seen[0]!)).toBe(true);
      await s.answer(MENU, "e"); // the menu is back for the same pair
      await s.answer(POST, "s");
      expect(await s.exit).toBe(0);
      expect(seen[1]).not.toBe(seen[0]);
      expect(existsSync(seen[0]!)).toBe(true); // the reviewer's copy stays
      expect(existsSync(seen[1]!)).toBe(false); // the step that ended with s removes its own
      expect((await head(sql, docId))!.state).toBe("DRAFT_AI");
    });
  });

  test("an editor that fails prints the message and the kept path, shows the menu again; s skips the pair", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      const s = start(sql, ["docs/intro"], {
        editor: editor(() => {
          throw new Error("editor vi exited with code 1");
        }),
      });
      await s.answer(MENU, "e");
      await s.expect("editor vi exited with code 1");
      await s.expect(`edit file kept: ${seen[0]}`);
      expect(existsSync(seen[0]!)).toBe(true);
      await s.answer(MENU, "s");
      expect(await s.exit).toBe(0);
      expect(s.output()).toContain(SUMMARY(0, 0, 1, 0, 0));
      expect((await head(sql, docId))!.state).toBe("DRAFT_AI");
    });
  });

  test("a value holding a header line is refused by e with no file written; the menu returns", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung", body: "eins\n=== title ===\nzwei" });
      const s = start(sql, ["docs/intro"], { editor: editor(() => void problems.push("the editor must not run")) });
      await s.answer(MENU, "e");
      await s.expect("looks like a section header");
      await s.answer(MENU, "s");
      expect(await s.exit).toBe(0);
      expect(seen).toEqual([]);
      expect(s.output()).not.toContain("edit file kept");
    });
  });

  test("end of input at the post-edit prompt keeps the edit file and prints its path", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      const s = start(sql, ["docs/intro"], { editor: editor(edit("Einleitung", "Neu")) });
      await s.answer(MENU, "e");
      await s.expect(POST);
      s.end();
      expect(await s.exit).toBe(0);
      expect(s.output()).toContain(`edit file kept: ${seen[0]}`);
      expect(existsSync(seen[0]!)).toBe(true);
      expect((await head(sql, docId))!.state).toBe("DRAFT_AI");
    });
  });

  test("an abort at the post-edit prompt keeps the edit file", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      const controller = new AbortController();
      const s = start(sql, ["docs/intro"], { signal: controller.signal, editor: editor(edit("Einleitung", "Neu")) });
      await s.answer(MENU, "e");
      await s.expect(POST);
      controller.abort();
      expect(await s.exit).toBe(0);
      expect(s.output()).toContain(`edit file kept: ${seen[0]}`);
      expect(existsSync(seen[0]!)).toBe(true);
    });
  });
});

describe("interactive review: failures and exit codes", () => {
  test("a draft replaced after it was shown is a conflict: not approved, exit 1", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      const v = await draftWith(sql, docId, "de", { title: "Einleitung" });
      const s = start(sql, ["docs/intro"]);
      await s.expect(MENU);
      const v2 = await aiDraft(sql, docId, "de", "Neu");
      s.send("a");
      expect(await s.exit).toBe(1);
      expect(s.output()).toContain(`Expected draft version ${v} of ${docId}/de but the head is ${v2}`);
      expect(s.output()).toContain(SUMMARY(0, 0, 0, 1, 0));
      const now = (await head(sql, docId))!;
      expect([now.state, now.version]).toEqual(["DRAFT_AI", v2]);
    });
  });

  test("a conflict at the post-edit approve keeps the edit file and prints its path", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      const s = start(sql, ["docs/intro"], {
        editor: editor(async (path) => {
          edit("Einleitung", "Neu")(path);
          await aiDraft(sql, docId, "de", "Ersatz");
        }),
      });
      await s.answer(MENU, "e");
      await s.answer(POST, "a");
      expect(await s.exit).toBe(1);
      expect(s.output()).toContain("Expected draft version");
      expect(s.output()).toContain(`edit file kept: ${seen[0]}`);
      expect(existsSync(seen[0]!)).toBe(true);
      expect((await head(sql, docId))!.state).toBe("DRAFT_AI");
    });
  });

  test("one approval and one conflict exit 4", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      await draftWith(sql, docId, "fr", { title: "Introduction" });
      const s = start(sql, []);
      await s.answer(MENU, "a");
      await s.expect(MENU);
      await aiDraft(sql, docId, "fr", "Neu");
      s.send("a");
      expect(await s.exit).toBe(4);
      expect(s.output()).toContain(SUMMARY(1, 0, 0, 1, 0));
      expect((await head(sql, docId, "fr"))!.state).toBe("DRAFT_AI");
    });
  });

  test("an approve refused after the editor rejected the pair is counted failed and the next pair is shown", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      const v = await draftWith(sql, docId, "de", { title: "Einleitung" });
      await draftWith(sql, docId, "fr", { title: "Introduction" });
      const s = start(sql, [], {
        editor: editor(async (path) => {
          edit("Einleitung", "Neu")(path);
          await rejectDraft(coreCtx(sql), { docId, locale: "de", expectedVersion: v });
        }),
      });
      await s.answer(MENU, "e");
      await s.answer(POST, "a");
      await s.expect("has no draft head to approve");
      await s.expect(`edit file kept: ${seen[0]}`);
      await s.answer(MENU, "s"); // the loop continued with fr
      expect(await s.exit).toBe(1);
      expect(s.output()).toContain(SUMMARY(0, 0, 1, 0, 1));
      expect(existsSync(seen[0]!)).toBe(true);
    });
  });

  test("a licence refusal mid-session prints the summary once, keeps the edit file and exits 3", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      const s = start(sql, ["docs/intro"], {
        editor: editor(async (path) => {
          edit("Einleitung", "Neu")(path);
          await setFirstMigration(sql, new Date(Date.now() - 31 * DAY));
        }),
      });
      await s.answer(MENU, "e");
      await s.answer(POST, "a");
      expect(await s.exit).toBe(3);
      expect(count(s.output(), SUMMARY(0, 0, 0, 0, 0))).toBe(1);
      expect(s.output()).toContain(`edit file kept: ${seen[0]}`);
      expect(existsSync(seen[0]!)).toBe(true);
      expect((await head(sql, docId))!.state).toBe("DRAFT_AI");
    });
  });
});
