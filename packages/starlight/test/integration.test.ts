import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import moggingStarlight from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("the @mogging/starlight Astro integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the default export is a no-op integration named @mogging/starlight", () => {
    expect(moggingStarlight()).toEqual({ name: "@mogging/starlight", hooks: {} });
    expect(moggingStarlight()).not.toBe(moggingStarlight());
  });

  it("the root entry imports nothing at run time", () => {
    const file = path.join(here, "../src/index.ts");
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
    const offenders: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) offenders.push(`import: ${node.getText(source)}`);
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) offenders.push(`re-export: ${node.getText(source)}`);
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
          offenders.push(`call: ${node.getText(source)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(offenders).toEqual([]);
  });

  it("loading and calling the root entry prints nothing", async () => {
    const spies = [
      vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"), vi.spyOn(console, "debug"),
      vi.spyOn(process.stdout, "write"), vi.spyOn(process.stderr, "write"),
    ];
    vi.resetModules();
    const mod = await import("../src/index.js");
    mod.default();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(0);
  });
});
