#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneRoot = path.join(packageRoot, ".next", "standalone");
const publishStandaloneRoot = path.join(packageRoot, "dist", "standalone");

if (!fs.existsSync(standaloneRoot)) {
  throw new Error("Missing .next/standalone. Run next build before preparing the package.");
}

copyIfExists(path.join(packageRoot, ".next", "static"), path.join(standaloneRoot, ".next", "static"));
copyIfExists(path.join(packageRoot, "public"), path.join(standaloneRoot, "public"));
pruneStandalone(standaloneRoot);
copyIfExists(standaloneRoot, publishStandaloneRoot, { dereference: true });
materializeSymlinks(publishStandaloneRoot);

function copyIfExists(source, target, options = {}) {
  if (!fs.existsSync(source)) {
    return;
  }
  fs.rmSync(target, { force: true, recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, ...options });
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

function materializeSymlinks(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    const stats = fs.lstatSync(fullPath);

    if (stats.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(fullPath);
      const resolvedTarget = path.resolve(path.dirname(fullPath), linkTarget);

      if (!fs.existsSync(resolvedTarget)) {
        fs.rmSync(fullPath, { force: true });
        continue;
      }

      const tempPath = `${fullPath}.materialized`;
      fs.rmSync(tempPath, { force: true, recursive: true });

      if (fs.statSync(resolvedTarget).isDirectory()) {
        fs.cpSync(resolvedTarget, tempPath, { recursive: true });
      } else {
        fs.copyFileSync(resolvedTarget, tempPath);
      }

      fs.rmSync(fullPath, { force: true, recursive: true });
      fs.renameSync(tempPath, fullPath);
    }

    if (fs.lstatSync(fullPath).isDirectory()) {
      materializeSymlinks(fullPath);
    }
  }
}

function shouldPruneFile(fileName) {
  return fileName.endsWith(".tgz") || /\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(fileName);
}

function shouldPruneDirectory(dirPath, dirName) {
  if (dirPath.includes(`${path.sep}node_modules${path.sep}`)) {
    return false;
  }

  const relativePath = path.relative(standaloneRoot, dirPath);
  const isRootGeneratedOutput = ["dist", "build"].includes(dirName) && !relativePath.includes(path.sep);

  return (
    [".git", "coverage", "storybook-static"].includes(dirName) ||
    isRootGeneratedOutput ||
    (dirName === "cache" && dirPath.includes(`${path.sep}.next${path.sep}`))
  );
}
