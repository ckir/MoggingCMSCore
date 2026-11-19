import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { migrate } from "@mogging/core";
import { withTestDb } from "../db.js";
import { ctxFor } from "./fixtures.js";
import { runScenario } from "./endState.js";

const D = "src/content/docs";
const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden", "import-end-state.json");

describe("the Starlight import end state", () => {
  test("three phases leave the stored end state of the golden", async () => {
    await withTestDb(async (sql) => {
      await migrate(sql);
      const actual = await runScenario(sql, ctxFor(sql));
      const [A, B, C] = actual;
      const outcome = (p: typeof A, rel: string) => p!.report.files.find((f) => f.file === `${D}/${rel}`)!;

      // A: three new pages; English and every complete translation published, c German incomplete and unpublished
      expect(A!.report.errors).toEqual([]);
      expect(A!.report.files.filter((f) => f.outcome === "created")).toHaveLength(3);
      for (const f of ["a.md", "b.md", "c.md", "de/a.md", "de/b.md", "zh-cn/a.md", "zh-cn/b.md", "zh-cn/c.md"]) {
        expect(outcome(A, f).published, f).toBe(true);
      }
      expect(outcome(A, "de/c.md").published).toBe(false);
      expect(A!.state.documents.map((d) => d.slug)).toEqual(["a", "b", "c"]);

      // B: a German edited, saved and not published
      expect(outcome(B, "de/a.md")).toMatchObject({ outcome: "updated", published: false });

      // C: b German saved and published; a German (pending draft from B) published
      expect(outcome(C, "de/b.md")).toMatchObject({ outcome: "updated", published: true });
      expect(outcome(C, "de/a.md")).toMatchObject({ outcome: "updated", published: true });

      if (process.env.UPDATE_GOLDEN === "1") {
        const generatedFromCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
        fs.writeFileSync(goldenPath, JSON.stringify({ generatedFromCommit, phases: actual }, null, 2) + "\n");
        return;
      }
      const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8")) as { generatedFromCommit: string; phases: unknown };
      expect(actual).toEqual(golden.phases);
    });
  });
});
