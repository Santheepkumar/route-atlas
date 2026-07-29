import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  JsxAttribute,
  Node,
  Project,
  QuoteKind,
  ScriptKind,
  SourceFile,
  SyntaxKind,
} from "ts-morph";
import type { GraphEdge, GraphNode, GraphNodeKind, ScanGraph } from "./types";
import {
  analyzeRouteSegments,
  cleanHrefPath,
  getNodeKindForSpecialFile,
  getRouteFileKind,
  isAssetFile,
  isSourceFile,
  parentRouteOf,
  routeMatchesHref,
  toRepoPath,
} from "./route-utils";

type ScanState = {
  repoRoot: string;
  appDir: string;
  srcDir: string;
  scanMode: ScanOptions["scanMode"];
  warnings: string[];
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  fileToNode: Map<string, string>;
  routeByPath: Map<string, string>;
};

export type ScanOptions = {
  targetRoot?: string;
  scanMode?: "local" | "external" | "json";
};

const ignoredDirectories = new Set([
  ".git",
  ".next",
  "node_modules",
  "out",
  "build",
  "dist",
  "coverage",
]);

const specialHierarchy = ["layout", "template", "error", "loading", "not-found", "page"];
const sourceScriptKinds = new Map([
  [".ts", ScriptKind.TS],
  [".tsx", ScriptKind.TSX],
  [".js", ScriptKind.JS],
  [".jsx", ScriptKind.JSX],
  [".mjs", ScriptKind.JS],
  [".mts", ScriptKind.TS],
  [".cjs", ScriptKind.JS],
  [".cts", ScriptKind.TS],
]);

export function createScanOptions(options: ScanOptions | string = {}): Required<ScanOptions> {
  const requestedRoot =
    typeof options === "string"
      ? options
      : options.targetRoot ?? process.env.PAGE_VISUALS_TARGET_ROOT ?? /*turbopackIgnore: true*/ process.cwd();
  const targetRoot = path.resolve(/*turbopackIgnore: true*/ requestedRoot);
  const scanMode =
    typeof options === "string"
      ? "local"
      : options.scanMode ?? (targetRoot === path.resolve(process.cwd()) ? "local" : "external");

  return {
    targetRoot,
    scanMode,
  };
}

export async function scanNextApp(options: ScanOptions | string = createScanOptions()): Promise<ScanGraph> {
  const scanOptions = createScanOptions(options);
  const normalizedRoot = scanOptions.targetRoot;
  const srcDir = path.join(/*turbopackIgnore: true*/ normalizedRoot, "src");
  const appDir = (await pathExists(path.join(/*turbopackIgnore: true*/ srcDir, "app")))
    ? path.join(/*turbopackIgnore: true*/ srcDir, "app")
    : path.join(/*turbopackIgnore: true*/ normalizedRoot, "app");

  const state: ScanState = {
    repoRoot: normalizedRoot,
    appDir,
    srcDir,
    scanMode: scanOptions.scanMode,
    warnings: [],
    nodes: new Map(),
    edges: new Map(),
    fileToNode: new Map(),
    routeByPath: new Map(),
  };

  if (!(await pathExists(appDir))) {
    throw new Error("No App Router directory found at src/app or app.");
  }

  const [sourceFiles, assetFiles, nextVersion] = await Promise.all([
    collectFiles(normalizedRoot, (file) => isSourceFile(file)),
    collectFiles(normalizedRoot, (file) => isAssetFile(file)),
    readNextVersion(normalizedRoot),
  ]);

  buildFileAndRouteNodes(state, sourceFiles, assetFiles);
  buildRouteStructureEdges(state);
  buildAstEdges(state, sourceFiles);

  const nodes = [...state.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...state.edges.values()].sort((a, b) => a.id.localeCompare(b.id));

  return {
    generatedAt: new Date().toISOString(),
    repoRoot: normalizedRoot,
    framework: {
      name: "next",
      version: nextVersion,
      router: "app",
    },
    summary: {
      targetRoot: normalizedRoot,
      appDir,
      scanMode: scanOptions.scanMode,
      totalNodes: nodes.length,
      totalEdges: edges.length,
      routes: nodes.filter((node) => node.kind === "route").length,
      pages: nodes.filter((node) => node.kind === "page").length,
      layouts: nodes.filter((node) => node.kind === "layout").length,
      routeHandlers: nodes.filter((node) => node.kind === "route-handler").length,
      components: nodes.filter((node) => node.kind === "component").length,
      externalPackages: nodes.filter((node) => node.kind === "external").length,
      dynamicRoutes: nodes.filter((node) => node.kind === "route" && node.dynamic).length,
      warnings: state.warnings.length,
    },
    nodes,
    edges,
    warnings: state.warnings,
  };
}

function buildFileAndRouteNodes(state: ScanState, sourceFiles: string[], assetFiles: string[]) {
  for (const filePath of assetFiles) {
    const repoPath = toRepoPath(state.repoRoot, filePath);
    addNode(state, {
      id: `asset:${repoPath}`,
      kind: "asset",
      label: path.basename(filePath),
      file: repoPath,
      metadata: {
        extension: path.extname(filePath),
      },
    });
  }

  for (const filePath of sourceFiles) {
    const repoPath = toRepoPath(state.repoRoot, filePath);
    const specialFile = filePath.startsWith(state.appDir)
      ? getRouteFileKind(filePath)
      : undefined;
    const segmentInfo = filePath.startsWith(state.appDir)
      ? analyzeRouteSegments(state.appDir, path.dirname(filePath))
      : undefined;

    const kind = classifyFile(filePath, specialFile);
    const nodeId = `${kind}:${repoPath}`;
    const route = specialFile && !segmentInfo?.private ? segmentInfo?.route : undefined;

    addNode(state, {
      id: nodeId,
      kind,
      label: fileLabel(filePath, specialFile),
      route,
      file: repoPath,
      segment: segmentInfo?.segment,
      dynamic: segmentInfo?.dynamic,
      specialFile,
      metadata: {
        extension: path.extname(filePath),
        routeGroups: segmentInfo?.routeGroups ?? [],
        slots: segmentInfo?.slots ?? [],
        intercepted: segmentInfo?.intercepted ?? [],
        privateRouteFolder: segmentInfo?.private ?? false,
      },
    });
    state.fileToNode.set(filePath, nodeId);

    if (specialFile && segmentInfo && !segmentInfo.private) {
      const routeNodeId = addRouteNode(state, segmentInfo.route, {
        segment: segmentInfo.segment,
        dynamic: segmentInfo.dynamic,
        routeGroups: segmentInfo.routeGroups,
        slots: segmentInfo.slots,
        intercepted: segmentInfo.intercepted,
      });
      addEdge(state, {
        kind: "route-owns-file",
        source: routeNodeId,
        target: nodeId,
        label: specialFile,
        confidence: "static",
        metadata: { specialFile },
      });

      if (specialFile === "route") {
        addEdge(state, {
          kind: "route-handler",
          source: routeNodeId,
          target: nodeId,
          label: "API",
          confidence: "static",
          metadata: {},
        });
      }

      for (const slot of segmentInfo.slots) {
        const parentRoute = parentRouteOf(segmentInfo.route) ?? "/";
        const parentRouteNodeId = addRouteNode(state, parentRoute);
        addEdge(state, {
          kind: "parallel-slot",
          source: parentRouteNodeId,
          target: routeNodeId,
          label: `@${slot}`,
          confidence: "static",
          metadata: { slot },
        });
      }

      for (const intercepted of segmentInfo.intercepted) {
        addEdge(state, {
          kind: "intercepts",
          source: routeNodeId,
          target: routeNodeId,
          label: intercepted,
          confidence: "inferred",
          metadata: { intercepted },
        });
      }
    }
  }
}

function buildRouteStructureEdges(state: ScanState) {
  for (const route of state.routeByPath.keys()) {
    const routeNodeId = state.routeByPath.get(route);
    if (!routeNodeId) {
      continue;
    }
    const parentRoute = parentRouteOf(route);
    if (parentRoute) {
      const parentNodeId = addRouteNode(state, parentRoute);
      addEdge(state, {
        kind: "route-nesting",
        source: parentNodeId,
        target: routeNodeId,
        label: "segment",
        confidence: "static",
        metadata: {},
      });
    }
  }

  const filesByRoute = new Map<string, GraphNode[]>();
  for (const node of state.nodes.values()) {
    if (!node.route || !node.specialFile) {
      continue;
    }
    const nodes = filesByRoute.get(node.route) ?? [];
    nodes.push(node);
    filesByRoute.set(node.route, nodes);
  }

  for (const [route, specialNodes] of filesByRoute) {
    for (let i = 0; i < specialHierarchy.length - 1; i += 1) {
      const outer = specialNodes.find((node) => node.specialFile === specialHierarchy[i]);
      if (!outer) {
        continue;
      }
      for (let j = i + 1; j < specialHierarchy.length; j += 1) {
        const inner = specialNodes.find((node) => node.specialFile === specialHierarchy[j]);
        if (inner) {
          addEdge(state, {
            kind: "layout-wraps",
            source: outer.id,
            target: inner.id,
            label: route,
            confidence: "static",
            metadata: { route },
          });
          break;
        }
      }
    }
  }
}

function buildAstEdges(state: ScanState, sourceFiles: string[]) {
  const tsConfigPath = path.join(/*turbopackIgnore: true*/ state.repoRoot, "tsconfig.json");
  const project = new Project({
    tsConfigFilePath: tsConfigPath,
    skipAddingFilesFromTsConfig: true,
    manipulationSettings: {
      quoteKind: QuoteKind.Double,
    },
  });

  for (const filePath of sourceFiles) {
    const scriptKind = sourceScriptKinds.get(path.extname(filePath)) ?? ScriptKind.TS;
    const sourceFile = project.addSourceFileAtPathIfExists(filePath);
    if (!sourceFile) {
      project.createSourceFile(filePath, "", { scriptKind, overwrite: false });
    }
  }

  for (const filePath of sourceFiles) {
    const sourceFile = project.getSourceFile(filePath);
    const sourceNodeId = state.fileToNode.get(filePath);
    if (!sourceFile || !sourceNodeId) {
      continue;
    }

    const importTargets = new Map<string, string>();
    for (const importDeclaration of sourceFile.getImportDeclarations()) {
      const specifier = importDeclaration.getModuleSpecifierValue();
      const targetNodeId = resolveImportToNode(state, sourceFile, specifier);
      addEdge(state, {
        kind: "imports",
        source: sourceNodeId,
        target: targetNodeId,
        label: specifier,
        confidence: "static",
        metadata: {},
      });

      const defaultImport = importDeclaration.getDefaultImport();
      if (defaultImport) {
        importTargets.set(defaultImport.getText(), targetNodeId);
      }
      const namespaceImport = importDeclaration.getNamespaceImport();
      if (namespaceImport) {
        importTargets.set(namespaceImport.getText(), targetNodeId);
      }
      for (const namedImport of importDeclaration.getNamedImports()) {
        importTargets.set(namedImport.getName(), targetNodeId);
      }
    }

    inspectExportsAndRuntimeSignals(state, sourceFile, sourceNodeId);
    inspectJsx(state, sourceFile, sourceNodeId, importTargets);
    inspectNavigationCalls(state, sourceFile, sourceNodeId);
  }
}

function inspectExportsAndRuntimeSignals(
  state: ScanState,
  sourceFile: SourceFile,
  sourceNodeId: string,
) {
  const text = sourceFile.getFullText();
  const sourceNode = state.nodes.get(sourceNodeId);
  if (!sourceNode) {
    return;
  }

  const exportedDeclarations = sourceFile.getExportedDeclarations();
  const exportedNames = [...exportedDeclarations.keys()];
  const route = sourceNode.route;

  state.nodes.set(sourceNodeId, {
    ...sourceNode,
    metadata: {
      ...sourceNode.metadata,
      clientComponent: hasTopLevelDirective(sourceFile, "use client"),
      serverDirective: hasTopLevelDirective(sourceFile, "use server"),
      exports: exportedNames,
      usesFetch: /\bfetch\s*\(/.test(text),
      usesCookies: /\bcookies\s*\(/.test(text),
      usesHeaders: /\bheaders\s*\(/.test(text),
      usesParams: /\bparams\b|useParams\s*\(/.test(text),
      usesSearchParams: /\bsearchParams\b|useSearchParams\s*\(/.test(text),
      generateStaticParams: exportedNames.includes("generateStaticParams"),
      generateMetadata: exportedNames.includes("generateMetadata") || exportedNames.includes("metadata"),
    },
  });

  if (route && /\bparams\b|useParams\s*\(/.test(text)) {
    const paramNodeId = addVirtualNode(state, "param", `params:${route}`, route, "params");
    addEdge(state, {
      kind: "dynamic-param",
      source: sourceNodeId,
      target: paramNodeId,
      label: "params",
      confidence: "inferred",
      metadata: { route },
    });
  }

  if (route && /\bsearchParams\b|useSearchParams\s*\(/.test(text)) {
    const paramNodeId = addVirtualNode(state, "param", `searchParams:${route}`, route, "search params");
    addEdge(state, {
      kind: "dynamic-param",
      source: sourceNodeId,
      target: paramNodeId,
      label: "searchParams",
      confidence: "inferred",
      metadata: { route },
    });
  }

  if (exportedNames.includes("generateMetadata") || exportedNames.includes("metadata")) {
    const metadataNodeId = addVirtualNode(state, "metadata", `metadata:${sourceNodeId}`, route, "metadata");
    addEdge(state, {
      kind: "metadata",
      source: sourceNodeId,
      target: metadataNodeId,
      label: "metadata",
      confidence: "static",
      metadata: { route },
    });
  }

  for (const match of text.matchAll(/\bfetch\s*\(\s*(['"`])([^'"`]+)\1/g)) {
    const endpoint = match[2];
    const dataNodeId = addVirtualNode(state, "data", `fetch:${endpoint}`, endpoint, endpoint);
    addEdge(state, {
      kind: "fetch-call",
      source: sourceNodeId,
      target: dataNodeId,
      label: "fetch",
      confidence: "static",
      metadata: { endpoint },
    });
  }

  for (const name of exportedNames) {
    const declarations = exportedDeclarations.get(name) ?? [];
    const hasInlineServerAction = declarations.some((declaration) =>
      declaration.getText().includes("'use server'") || declaration.getText().includes('"use server"'),
    );
    if (hasInlineServerAction || (hasTopLevelDirective(sourceFile, "use server") && name !== "default")) {
      const actionNodeId = addVirtualNode(state, "data", `server-action:${sourceNodeId}:${name}`, route, name);
      addEdge(state, {
        kind: "server-action",
        source: sourceNodeId,
        target: actionNodeId,
        label: name,
        confidence: "static",
        metadata: { action: name },
      });
    }
  }
}

function inspectJsx(
  state: ScanState,
  sourceFile: SourceFile,
  sourceNodeId: string,
  importTargets: Map<string, string>,
) {
  const jsxElements = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];

  for (const jsxElement of jsxElements) {
    const tagName = jsxElement.getTagNameNode().getText();
    const rootTagName = tagName.split(".")[0];

    if (/^[A-Z]/.test(rootTagName)) {
      const targetNodeId = importTargets.get(rootTagName);
      if (targetNodeId) {
        addEdge(state, {
          kind: "component-use",
          source: sourceNodeId,
          target: targetNodeId,
          label: rootTagName,
          confidence: "static",
          metadata: {},
        });
      }
    }

    if (tagName === "Link" || tagName.endsWith(".Link")) {
      const href = readJsxStringAttribute(jsxElement, "href");
      if (href) {
        addNavigationEdge(state, "next-link", sourceNodeId, href);
      }
    }

    if (tagName === "a") {
      const href = readJsxStringAttribute(jsxElement, "href");
      if (href) {
        addNavigationEdge(state, "anchor-link", sourceNodeId, href);
      }
    }
  }
}

function inspectNavigationCalls(state: ScanState, sourceFile: SourceFile, sourceNodeId: string) {
  const text = sourceFile.getFullText();
  for (const match of text.matchAll(/\b(?:router|navigation)\.(?:push|replace)\(\s*(['"`])([^'"`]+)\1/g)) {
    addNavigationEdge(state, "router-navigation", sourceNodeId, match[2]);
  }
}

function addNavigationEdge(
  state: ScanState,
  kind: "next-link" | "anchor-link" | "router-navigation",
  sourceNodeId: string,
  href: string,
) {
  if (!href.startsWith("/")) {
    const externalNodeId = addExternalNode(state, href);
    addEdge(state, {
      kind,
      source: sourceNodeId,
      target: externalNodeId,
      label: href,
      confidence: "static",
      metadata: { href },
    });
    return;
  }

  const cleanHref = cleanHrefPath(href);
  const targetRouteId = findRouteNodeForHref(state, cleanHref);
  const targetNodeId = targetRouteId ?? addVirtualNode(state, "route", `route:${cleanHref}`, cleanHref, cleanHref);
  addEdge(state, {
    kind,
    source: sourceNodeId,
    target: targetNodeId,
    label: href,
    confidence: targetRouteId ? "static" : "inferred",
    metadata: { href },
  });
}

function resolveImportToNode(state: ScanState, sourceFile: SourceFile, specifier: string) {
  const resolvedFile = resolveLocalImport(state.repoRoot, sourceFile.getFilePath(), specifier);
  if (resolvedFile) {
    if (state.fileToNode.has(resolvedFile)) {
      return state.fileToNode.get(resolvedFile) as string;
    }
    if (isAssetFile(resolvedFile)) {
      const repoPath = toRepoPath(state.repoRoot, resolvedFile);
      const assetId = `asset:${repoPath}`;
      addNode(state, {
        id: assetId,
        kind: "asset",
        label: path.basename(resolvedFile),
        file: repoPath,
        metadata: { extension: path.extname(resolvedFile) },
      });
      return assetId;
    }
  }

  if (specifier.startsWith(".") || specifier.startsWith("@/")) {
    const unresolvedId = `utility:unresolved:${specifier}`;
    addNode(state, {
      id: unresolvedId,
      kind: "utility",
      label: specifier,
      metadata: { unresolved: true },
    });
    return unresolvedId;
  }

  return addExternalNode(state, packageNameFromSpecifier(specifier));
}

function resolveLocalImport(repoRoot: string, sourceFilePath: string, specifier: string) {
  let basePath: string | undefined;
  if (specifier.startsWith(".")) {
    basePath = path.resolve(/*turbopackIgnore: true*/ path.dirname(sourceFilePath), specifier);
  } else if (specifier.startsWith("@/")) {
    basePath = path.resolve(/*turbopackIgnore: true*/ repoRoot, "src", specifier.slice(2));
  }

  if (!basePath) {
    return undefined;
  }

  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.mjs`,
    `${basePath}.mts`,
    `${basePath}.svg`,
    `${basePath}.png`,
    path.join(/*turbopackIgnore: true*/ basePath, "index.ts"),
    path.join(/*turbopackIgnore: true*/ basePath, "index.tsx"),
    path.join(/*turbopackIgnore: true*/ basePath, "index.js"),
    path.join(/*turbopackIgnore: true*/ basePath, "index.jsx"),
  ];

  return candidates.find((candidate) => {
    try {
      return fsSync.existsSync(/*turbopackIgnore: true*/ candidate) && fsSync.statSync(/*turbopackIgnore: true*/ candidate).isFile();
    } catch {
      return false;
    }
  });
}

function readJsxStringAttribute(
  jsxElement:
    | import("ts-morph").JsxOpeningElement
    | import("ts-morph").JsxSelfClosingElement,
  name: string,
) {
  const attribute = jsxElement
    .getAttributes()
    .find((attr): attr is JsxAttribute => Node.isJsxAttribute(attr) && attr.getNameNode().getText() === name);
  const initializer = attribute?.getInitializer();
  if (!initializer) {
    return undefined;
  }
  if (Node.isStringLiteral(initializer)) {
    return initializer.getLiteralText();
  }
  if (Node.isJsxExpression(initializer)) {
    const expression = initializer.getExpression();
    if (expression && Node.isStringLiteral(expression)) {
      return expression.getLiteralText();
    }
    if (expression && Node.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.getLiteralText();
    }
  }
  return undefined;
}

function addRouteNode(
  state: ScanState,
  route: string,
  metadata: {
    segment?: string;
    dynamic?: boolean;
    routeGroups?: string[];
    slots?: string[];
    intercepted?: string[];
  } = {},
) {
  const id = `route:${route}`;
  const existing = state.nodes.get(id);
  addNode(state, {
    id,
    kind: "route",
    label: route,
    route,
    segment: metadata.segment ?? existing?.segment ?? route.split("/").filter(Boolean).at(-1) ?? "/",
    dynamic: Boolean(metadata.dynamic ?? existing?.dynamic),
    metadata: {
      ...(existing?.metadata ?? {}),
      routeGroups: metadata.routeGroups ?? existing?.metadata.routeGroups ?? [],
      slots: metadata.slots ?? existing?.metadata.slots ?? [],
      intercepted: metadata.intercepted ?? existing?.metadata.intercepted ?? [],
    },
  });
  state.routeByPath.set(route, id);
  return id;
}

function addVirtualNode(
  state: ScanState,
  kind: GraphNodeKind,
  id: string,
  route: string | undefined,
  label: string,
) {
  addNode(state, {
    id,
    kind,
    label,
    route,
    metadata: {},
  });
  return id;
}

function addExternalNode(state: ScanState, label: string) {
  const id = `external:${label}`;
  addNode(state, {
    id,
    kind: "external",
    label,
    metadata: {},
  });
  return id;
}

function addNode(state: ScanState, node: GraphNode) {
  const existing = state.nodes.get(node.id);
  state.nodes.set(node.id, {
    ...existing,
    ...node,
    metadata: {
      ...(existing?.metadata ?? {}),
      ...node.metadata,
    },
  });
}

function addEdge(state: ScanState, edge: Omit<GraphEdge, "id">) {
  const id = `${edge.kind}:${edge.source}->${edge.target}:${edge.label ?? ""}`;
  state.edges.set(id, { id, ...edge });
}

function findRouteNodeForHref(state: ScanState, href: string) {
  const exact = state.routeByPath.get(href);
  if (exact) {
    return exact;
  }

  for (const [route, nodeId] of state.routeByPath) {
    if (routeMatchesHref(route, href)) {
      return nodeId;
    }
  }
  return undefined;
}

function classifyFile(filePath: string, specialFile?: string): GraphNodeKind {
  if (specialFile) {
    return getNodeKindForSpecialFile(specialFile) as GraphNodeKind;
  }

  const baseName = path.basename(filePath).toLowerCase();
  const normalized = filePath.toLowerCase();
  if (baseName.includes("component") || normalized.includes("/components/") || normalized.includes("/ui/")) {
    return "component";
  }
  if (baseName.includes("data") || normalized.includes("/data/") || normalized.includes("/lib/")) {
    return "data";
  }
  return "utility";
}

function fileLabel(filePath: string, specialFile?: string) {
  if (specialFile) {
    return specialFile;
  }
  return path.basename(filePath);
}

function hasTopLevelDirective(sourceFile: SourceFile, directive: "use client" | "use server") {
  for (const statement of sourceFile.getStatements().slice(0, 5)) {
    if (statement.getKind() !== SyntaxKind.ExpressionStatement) {
      return false;
    }
    const text = statement.getText().replace(/;$/, "");
    if (text === `'${directive}'` || text === `"${directive}"`) {
      return true;
    }
  }
  return false;
}

function packageNameFromSpecifier(specifier: string) {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

async function collectFiles(repoRoot: string, predicate: (file: string) => boolean) {
  const files: string[] = [];

  async function walk(dir: string) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(/*turbopackIgnore: true*/ dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await walk(fullPath);
        }
        continue;
      }
      if (entry.isFile() && predicate(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  await walk(repoRoot);
  return files;
}

async function readNextVersion(repoRoot: string) {
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(/*turbopackIgnore: true*/ repoRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return packageJson.dependencies?.next ?? packageJson.devDependencies?.next ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function pathExists(filePath: string) {
  try {
    await fs.access(/*turbopackIgnore: true*/ filePath);
    return true;
  } catch {
    return false;
  }
}
