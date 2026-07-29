#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3133;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseCliArgs(argv) {
  const args = [...argv];
  const command = args[0] === "scan" ? args.shift() : "serve";
  const parsed = {
    command,
    projectPath: undefined,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    out: undefined,
    help: false,
    version: false,
    explicitPort: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--version" || arg === "-v") {
      parsed.version = true;
    } else if (arg === "--host" || arg === "-H") {
      parsed.host = readValue(args, index, arg);
      index += 1;
    } else if (arg === "--port" || arg === "-p") {
      parsed.port = Number(readValue(args, index, arg));
      parsed.explicitPort = true;
      index += 1;
    } else if (arg === "--out") {
      parsed.out = readValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!parsed.projectPath) {
      parsed.projectPath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
    throw new Error("Port must be a number between 1 and 65535.");
  }

  return parsed;
}

export function resolveTargetRoot(projectPath = process.cwd()) {
  const targetRoot = path.resolve(projectPath);
  const appDir = path.join(targetRoot, "app");
  const srcAppDir = path.join(targetRoot, "src", "app");
  if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
    throw new Error(`Project path does not exist: ${targetRoot}`);
  }
  if (!fs.existsSync(appDir) && !fs.existsSync(srcAppDir)) {
    throw new Error(`No Next.js App Router directory found in ${targetRoot}. Expected app or src/app.`);
  }
  return targetRoot;
}

export async function findAvailablePort(host, requestedPort, explicitPort = false) {
  let port = requestedPort;
  while (port <= 65535) {
    if (await canBind(host, port)) {
      return port;
    }
    if (explicitPort) {
      throw new Error(`Port ${requestedPort} is already in use on ${host}.`);
    }
    port += 1;
  }
  throw new Error(`No free port found at or above ${requestedPort}.`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);

  if (options.help) {
    console.log(helpText());
    return 0;
  }

  if (options.version) {
    console.log(readPackageVersion());
    return 0;
  }

  const targetRoot = resolveTargetRoot(options.projectPath);
  const port = await findAvailablePort(options.host, options.port, options.explicitPort);

  if (options.command === "scan") {
    await runJsonScan({ targetRoot, host: options.host, port, out: options.out });
    return 0;
  }

  await runVisualizer({ targetRoot, host: options.host, port });
  return 0;
}

async function runVisualizer({ targetRoot, host, port }) {
  const child = startProductionServer({ targetRoot, host, port, stdio: "inherit", scanMode: "external" });
  console.log(`\nRoute Atlas scanning: ${targetRoot}`);
  console.log(`Open http://${host}:${port}\n`);
  forwardSignals(child);
  try {
    const exitCode = await waitForExit(child);
    process.exitCode = exitCode;
  } finally {
    cleanupRuntime(child);
  }
}

async function runJsonScan({ targetRoot, host, port, out }) {
  const child = startProductionServer({ targetRoot, host, port, stdio: "pipe", scanMode: "json" });
  let logs = "";
  child.stdout?.on("data", (chunk) => {
    logs += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    logs += String(chunk);
  });

  try {
    const graph = await waitForScanJson(host, port);
    const json = `${JSON.stringify(graph, null, 2)}\n`;
    if (out) {
      fs.writeFileSync(path.resolve(out), json, "utf8");
      console.log(`Wrote ${path.resolve(out)}`);
    } else {
      process.stdout.write(json);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scan failed.";
    throw new Error(`${message}\n${logs.slice(-2000)}`);
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child, 2000);
  }
}

function startProductionServer({ targetRoot, host, port, stdio, scanMode }) {
  const standaloneRoot = path.join(packageRoot, ".next", "standalone");
  const serverEntry = path.join(standaloneRoot, "server.js");
  if (!fs.existsSync(serverEntry)) {
    throw new Error("Route Atlas production bundle is missing. Run `pnpm build` before using the local CLI, or reinstall the npm package.");
  }
  ensureStandaloneAliases(standaloneRoot);
  const child = spawn(
    process.execPath,
    [serverEntry],
    {
      cwd: standaloneRoot,
      env: {
        ...process.env,
        HOSTNAME: host,
        NODE_ENV: "production",
        PAGE_VISUALS_TARGET_ROOT: targetRoot,
        PAGE_VISUALS_PORT: String(port),
        PAGE_VISUALS_SCAN_MODE: scanMode,
        PORT: String(port),
      },
      stdio,
    },
  );
  return child;
}

export function ensureStandaloneAliases(standaloneRoot) {
  const aliases = findStandaloneExternalAliases(standaloneRoot);
  if (!aliases.size) {
    return;
  }

  const aliasRoot = path.join(standaloneRoot, ".next", "node_modules");
  fs.mkdirSync(aliasRoot, { recursive: true });
  for (const alias of aliases) {
    const packageName = packageNameFromHashedAlias(alias);
    if (!packageName) {
      continue;
    }
    const target = resolveStandalonePackageDirectory(standaloneRoot, packageName);
    const link = path.join(aliasRoot, alias);
    if (!target || fs.existsSync(link)) {
      continue;
    }
    try {
      fs.symlinkSync(path.relative(aliasRoot, target), link, "dir");
    } catch {
      fs.cpSync(target, link, { recursive: true });
    }
  }
}

function resolveStandalonePackageDirectory(standaloneRoot, packageName) {
  const direct = path.join(standaloneRoot, "node_modules", packageName);
  if (fs.existsSync(direct)) {
    return direct;
  }

  const pnpmRoot = path.join(standaloneRoot, "node_modules", ".pnpm");
  let entries;
  try {
    entries = fs.readdirSync(pnpmRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(pnpmRoot, entry.name, "node_modules", packageName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findStandaloneExternalAliases(standaloneRoot) {
  const aliases = new Set();
  const serverRoot = path.join(standaloneRoot, ".next", "server");
  const aliasPattern = /(?<!node_modules\/)([a-zA-Z0-9_@/.-]+-[a-f0-9]{8,})/g;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !/\.[cm]?js$/.test(entry.name)) {
        continue;
      }
      const text = fs.readFileSync(fullPath, "utf8");
      for (const match of text.matchAll(aliasPattern)) {
        const alias = match[1];
        if (!alias.includes("/")) {
          aliases.add(alias);
        }
      }
    }
  }

  walk(serverRoot);
  return aliases;
}

function packageNameFromHashedAlias(alias) {
  const match = /^(.*)-[a-f0-9]{8,}$/.exec(alias);
  return match?.[1];
}

async function waitForScanJson(host, port) {
  const deadline = Date.now() + 30000;
  let lastError = "Server did not respond.";
  while (Date.now() < deadline) {
    try {
      const response = await requestJson(`http://${host}:${port}/api/scan`);
      if (response.status >= 200 && response.status < 300) {
        return response.body;
      }
      lastError = `Scan API returned ${response.status}.`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Scan request failed.";
    }
    await delay(350);
  }
  throw new Error(lastError);
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(body),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.setTimeout(2000, () => {
      request.destroy(new Error("Scan API timed out."));
    });
  });
}

function canBind(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function readValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    return packageJson.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function helpText() {
  return `route-atlas

Usage:
  route-atlas [projectPath] [--port 3133] [--host 127.0.0.1]
  route-atlas scan [projectPath] [--out scan.json]

Examples:
  route-atlas
  route-atlas ../my-next-app --port 4000
  route-atlas scan . --out route-atlas.scan.json
`;
}

function forwardSignals(child) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      child.kill(signal);
    });
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode ?? 0);
      return;
    }
    const timeout = timeoutMs
      ? setTimeout(() => {
          child.off("exit", onExit);
          resolve(child.exitCode ?? 0);
        }, timeoutMs)
      : undefined;
    function onExit(code) {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(code ?? 0);
    }
    child.once("exit", onExit);
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isDirectCliInvocation(argvPath = process.argv[1]) {
  if (!argvPath) {
    return false;
  }
  try {
    return fs.realpathSync(argvPath) === fileURLToPath(import.meta.url);
  } catch {
    return pathToFileURL(argvPath).href === import.meta.url;
  }
}

if (isDirectCliInvocation()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
