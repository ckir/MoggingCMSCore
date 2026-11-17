import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { describe, expect, test } from "vitest";
import { defineStarlightLayout } from "@mogging/markdown";
import { localeDrift, readAstroConfig } from "../src/starlight/astroConfig.js";
import { starlightConfigText } from "../src/starlight/initStarlight.js";

// The starter template is a plain folder (not a workspace member, nothing installed in it); these tests read its
// files and load its Mogging config offline, with the workspace sources aliased in place of installed packages.
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const TEMPLATE = join(REPO, "templates", "starlight");
const text = (rel: string): string => readFileSync(join(TEMPLATE, rel), "utf8");

describe("the starlight template", () => {
  test("the template's astro.config reads statically and matches its Mogging config", async () => {
    const read = readAstroConfig(TEMPLATE);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.reason);
    expect(read.locales).toEqual([
      { key: "root", lang: "en", label: "English" },
      { key: "de", lang: "de", label: "Deutsch" },
      { key: "zh-cn", lang: "zh-CN", label: "简体中文" },
    ]);
    expect(read.docsDir).toBe("src/content/docs");

    const jiti = createJiti(import.meta.url, {
      alias: {
        "@mogging/core": join(REPO, "packages/core/src/index.ts"),
        "@mogging/starlight/preset": join(REPO, "packages/starlight/src/preset.ts"),
      },
    });
    const mod = (await jiti.import(join(TEMPLATE, "mogging.config.ts"))) as {
      config: unknown;
      starlight: unknown;
    };
    const layout = defineStarlightLayout(mod.starlight as never, mod.config as never);
    expect(localeDrift(read, layout)).toEqual([]);
  });

  test("mogging.config.ts is what init --starlight writes", () => {
    expect(text("mogging.config.ts")).toBe(
      starlightConfigText({
        source: "en",
        targets: [{ tag: "de", dir: "de" }, { tag: "zh-CN", dir: "zh-cn" }],
        sourceDir: null,
        docsDir: "src/content/docs",
        pasteBlock: null,
        warnings: [],
      }),
    );
  });

  test("package.json pins", () => {
    const pkg = JSON.parse(text("package.json")) as {
      name: string; private: boolean; type: string;
      scripts: Record<string, string>;
      engines: { node: string };
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.name).toBe("mogging-starlight-template");
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect(pkg.engines.node).toBe(">=22.23.4");
    expect(pkg.dependencies).toEqual({
      astro: "7.4.4",
      "@astrojs/starlight": "0.43.0",
      sharp: "0.35.4",
      "@mogging/starlight": "0.0.0",
    });
    expect(pkg.devDependencies).toEqual({
      "@mogging/cli": "0.0.0",
      "@mogging/core": "0.0.0",
      "@mogging/ai": "0.0.0",
    });
    expect(pkg.scripts.mogging).toBe("node --env-file=.env node_modules/@mogging/cli/dist/bin.js");
    expect(pkg.scripts.dev).toBe("astro dev");
    expect(pkg.scripts.build).toBe("astro build");
    expect(pkg.scripts.preview).toBe("astro preview");
    expect(pkg.scripts.astro).toBe("astro");
  });

  test("the database URL agrees across .env.example and compose.yaml", () => {
    const env = /^DATABASE_URL=(.+)$/m.exec(text(".env.example"));
    expect(env).not.toBeNull();
    const url = new URL(env![1]!);
    expect(url.protocol).toBe("postgres:");

    const compose = text("compose.yaml");
    const value = (key: string): string | undefined =>
      new RegExp(`^\\s*${key}:\\s*"?([^"\\n]+?)"?\\s*$`, "m").exec(compose)?.[1];
    expect(value("POSTGRES_USER")).toBe(decodeURIComponent(url.username));
    expect(value("POSTGRES_PASSWORD")).toBe(decodeURIComponent(url.password));
    expect(value("POSTGRES_DB")).toBe(url.pathname.slice(1));
    expect(/^\s*-\s*"?(\d+):5432"?\s*$/m.exec(compose)?.[1]).toBe(url.port);
  });

  test("README puts the licence first and the session in order", () => {
    const readme = text("README.md");
    const firstHeading = /^## (.+)$/m.exec(readme);
    expect(firstHeading?.[1]).toContain("Licence");

    // The command lines: lines inside fenced code blocks that start with `npm run`.
    const commands: string[] = [];
    let inFence = false;
    for (const raw of readme.split("\n")) {
      const line = raw.trimStart(); // the fences sit inside numbered list items, so they are indented
      if (line.startsWith("```")) { inFence = !inFence; continue; }
      if (inFence && line.startsWith("npm run")) commands.push(line);
    }
    const order = ["-- migrate", "-- import", "-- compile --locales", "-- review", "-- release publish", "-- export", "npm run build"];
    let previous = -1;
    for (const needle of order) {
      const at = commands.findIndex((c) => c.includes(needle));
      expect(at, `a command line containing ${needle}`).toBeGreaterThan(-1);
      expect(at, `${needle} comes after the one before it`).toBeGreaterThan(previous);
      previous = at;
    }

    // A bare `publish` is a usage error (a target or --release is required).
    for (const c of commands) {
      if (c.includes("-- publish")) expect(c).toMatch(/-- publish\s+(--release\s+\S+|\S+\/\S+)/);
    }

    // The release name is a placeholder the README explains: a new name for every batch.
    expect(readme).toContain("release create <name>");
    expect(readme).toMatch(/new (release )?name/i);
    expect(readme).toContain("ConflictError");
  });
});
