#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneRoot = path.join(packageRoot, ".next", "standalone");

if (!fs.existsSync(standaloneRoot)) {
  throw new Error("Missing .next/standalone. Run next build before preparing the package.");
}

copyIfExists(path.join(packageRoot, ".next", "static"), path.join(standaloneRoot, ".next", "static"));
copyIfExists(path.join(packageRoot, "public"), path.join(standaloneRoot, "public"));
pruneStandalone(standaloneRoot);

function copyIfExists(source, target) {
  if (!fs.existsSync(source)) {
    return;
  }
  fs.rmSync(target, { force: true, recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function pruneStandalone(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (shouldPruneDirectory(fullPath, entry.name)) {
        fs.rmSync(fullPath, { force: true, recursive: true });
        continue;
      }
      pruneStandalone(fullPath);
      continue;
    }
    if (shouldPruneFile(entry.name)) {
      fs.rmSync(fullPath, { force: true });
    }
  }
}

function shouldPruneFile(fileName) {
  return fileName.endsWith(".tgz") || /\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(fileName);
}

function shouldPruneDirectory(dirPath, dirName) {
  return (
    [".git", "coverage", "storybook-static"].includes(dirName) ||
    (dirName === "cache" && dirPath.includes(`${path.sep}.next${path.sep}`))
  );
}
