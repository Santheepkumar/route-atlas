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
promotePnpmAliases(publishStandaloneRoot);
hydrateTopLevelPackageDependencies(publishStandaloneRoot);
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

function promotePnpmAliases(root) {
  const aliasRoot = path.join(root, "node_modules", ".pnpm", "node_modules");
  const nodeModulesRoot = path.join(root, "node_modules");
  if (!fs.existsSync(aliasRoot)) {
    return;
  }

  for (const entry of fs.readdirSync(aliasRoot, { withFileTypes: true })) {
    const source = path.join(aliasRoot, entry.name);
    if (entry.isDirectory() && entry.name.startsWith("@")) {
      for (const scopedEntry of fs.readdirSync(source, { withFileTypes: true })) {
        copyAliasPackage(
          path.join(source, scopedEntry.name),
          path.join(nodeModulesRoot, entry.name, scopedEntry.name),
          `${entry.name}/${scopedEntry.name}`,
        );
      }
      continue;
    }
    copyAliasPackage(source, path.join(nodeModulesRoot, entry.name), entry.name);
  }
}

function copyAliasPackage(source, target, packageName) {
  const installedSource = findInstalledPackageSource(packageName);
  const copySource = fs.existsSync(installedSource) ? installedSource : source;
  if (!fs.existsSync(copySource)) {
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(copySource, target, { force: true, recursive: true, dereference: true });
  return true;
}

function hydrateTopLevelPackageDependencies(root) {
  const nodeModulesRoot = path.join(root, "node_modules");
  if (!fs.existsSync(nodeModulesRoot)) {
    return;
  }

  let copied = true;
  while (copied) {
    copied = false;
    for (const packageName of listTopLevelPackages(nodeModulesRoot)) {
      const packageJsonPath = path.join(nodeModulesRoot, packageName, "package.json");
      if (!fs.existsSync(packageJsonPath)) {
        continue;
      }

      let packageJson;
      try {
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      } catch {
        continue;
      }

      const dependencies = {
        ...packageJson.dependencies,
        ...packageJson.optionalDependencies,
      };

      for (const dependencyName of Object.keys(dependencies)) {
        const dependencyTarget = path.join(nodeModulesRoot, dependencyName);
        if (fs.existsSync(dependencyTarget)) {
          continue;
        }
        copied = copyAliasPackage(dependencyTarget, dependencyTarget, dependencyName) || copied;
      }
    }
  }
}

function listTopLevelPackages(nodeModulesRoot) {
  const packages = [];
  for (const entry of fs.readdirSync(nodeModulesRoot, { withFileTypes: true })) {
    if (entry.name === ".pnpm") {
      continue;
    }
    if (entry.isDirectory() && entry.name.startsWith("@")) {
      const scopeRoot = path.join(nodeModulesRoot, entry.name);
      for (const scopedEntry of fs.readdirSync(scopeRoot, { withFileTypes: true })) {
        if (scopedEntry.isDirectory()) {
          packages.push(`${entry.name}/${scopedEntry.name}`);
        }
      }
      continue;
    }
    if (entry.isDirectory()) {
      packages.push(entry.name);
    }
  }
  return packages;
}

function findInstalledPackageSource(packageName) {
  const direct = path.join(packageRoot, "node_modules", packageName);
  if (fs.existsSync(direct)) {
    return direct;
  }

  const pnpmRoot = path.join(packageRoot, "node_modules", ".pnpm");
  if (!fs.existsSync(pnpmRoot)) {
    return direct;
  }

  for (const entry of fs.readdirSync(pnpmRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(pnpmRoot, entry.name, "node_modules", packageName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return direct;
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
