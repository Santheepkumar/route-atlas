import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { isDirectCliInvocation, parseCliArgs, resolveTargetRoot } from "./route-atlas.mjs";

let fixtureRoot;

describe("route-atlas CLI", () => {
  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "route-atlas-cli-"));
    await fs.mkdir(path.join(fixtureRoot, "src", "app"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { force: true, recursive: true });
  });

  it("parses the default serve command", () => {
    expect(parseCliArgs([])).toMatchObject({
      command: "serve",
      host: "127.0.0.1",
      port: 3133,
    });
  });

  it("parses explicit project path, host, and port", () => {
    expect(parseCliArgs(["../app", "--host", "0.0.0.0", "--port", "4000"])).toMatchObject({
      command: "serve",
      projectPath: "../app",
      host: "0.0.0.0",
      port: 4000,
      explicitPort: true,
    });
  });

  it("parses JSON scan output", () => {
    expect(parseCliArgs(["scan", ".", "--out", "scan.json"])).toMatchObject({
      command: "scan",
      projectPath: ".",
      out: "scan.json",
    });
  });

  it("accepts Next.js App Router projects", () => {
    expect(resolveTargetRoot(fixtureRoot)).toBe(fixtureRoot);
  });

  it("rejects paths without app or src/app", async () => {
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "route-atlas-empty-"));
    try {
      expect(() => resolveTargetRoot(emptyRoot)).toThrow("No Next.js App Router directory");
    } finally {
      await fs.rm(emptyRoot, { force: true, recursive: true });
    }
  });

  it("detects direct invocation through a symlinked npm bin", async () => {
    const linkPath = path.join(fixtureRoot, "route-atlas");
    await fs.symlink(fileURLToPath(new URL("./route-atlas.mjs", import.meta.url)), linkPath);

    expect(isDirectCliInvocation(linkPath)).toBe(true);
  });
});
