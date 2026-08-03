import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import type { GraphEdge, GraphEdgeKind, GraphNode, GraphNodeKind, ScanGraph } from "./types";

export type Mode = "story" | "routes" | "components" | "data" | "navigation" | "all";
export type LargeGraphMode = "guarded" | "full";
export type SceneLOD = "cluster" | "overview" | "detail";

export type SceneViewport = {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
};

export type SceneNode = GraphNode & {
  x: number;
  y: number;
  width: number;
  height: number;
  badges: string[];
  quiet: boolean;
};

export type SceneEdge = GraphEdge & {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
};

export type SceneGraph = {
  nodes: SceneNode[];
  edges: SceneEdge[];
  quietNodeIds: string[];
  hiddenNodeCount: number;
  hiddenEdgeCount: number;
  lod: SceneLOD;
  bounds: { x: number; y: number; width: number; height: number };
  graphIsLarge: boolean;
  renderWithCanvas: boolean;
  usedFastLayout: boolean;
  timings: {
    deriveMs: number;
    layoutMs: number;
    totalMs: number;
  };
};

export type WorkerJob = {
  id: number;
  graph: ScanGraph | null;
  mode: Mode;
  query: string;
  selectedId: string | null;
  largeGraphMode: LargeGraphMode;
  viewport?: SceneViewport;
};

export type WorkerResult = {
  id: number;
  scene: SceneGraph;
  status: "ready" | "failed";
  error?: string;
};

export type SceneWorkerRequest =
  | { type: "set-graph"; graph: ScanGraph | null }
  | { type: "derive"; job: WorkerJob };

const elk = new ELK({
  defaultLayoutOptions: {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.spacing.nodeNode": "36",
    "elk.layered.spacing.nodeNodeBetweenLayers": "86",
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    "elk.edgeRouting": "SPLINES",
  },
});

const routeNodeKinds = new Set<GraphNodeKind>([
  "route",
  "page",
  "layout",
  "template",
  "loading",
  "error",
  "not-found",
  "default",
  "route-handler",
]);

const storyEdgeKinds = new Set<GraphEdgeKind>([
  "route-nesting",
  "route-owns-file",
  "layout-wraps",
  "parallel-slot",
  "intercepts",
  "route-handler",
  "next-link",
  "anchor-link",
  "router-navigation",
]);

const expansionEdgeKinds = new Set<GraphEdgeKind>([
  "imports",
  "component-use",
  "fetch-call",
  "server-action",
  "metadata",
  "dynamic-param",
]);

const allGuardedEdgeKinds = new Set<GraphEdgeKind>([
  ...storyEdgeKinds,
  "fetch-call",
  "server-action",
  "metadata",
  "dynamic-param",
]);

const edgeKindsByMode: Record<Exclude<Mode, "story" | "all">, Set<GraphEdgeKind>> = {
  routes: new Set(["route-nesting", "route-owns-file", "layout-wraps", "parallel-slot", "intercepts", "route-handler"]),
  components: new Set(["imports", "component-use"]),
  data: new Set(["fetch-call", "server-action", "metadata", "dynamic-param"]),
  navigation: new Set(["next-link", "anchor-link", "router-navigation"]),
};

const layoutCache = new Map<string, SceneNode[]>();

const CANVAS_NODE_THRESHOLD = 160;
const CANVAS_EDGE_THRESHOLD = 360;
const FAST_LAYOUT_NODE_THRESHOLD = 850;
const FAST_LAYOUT_EDGE_THRESHOLD = 2200;
const LARGE_MODE_NODE_BUDGET = 420;
const LARGE_MODE_EDGE_BUDGET = 1200;

export async function deriveSceneGraph(job: Omit<WorkerJob, "id">): Promise<SceneGraph> {
  const totalStart = now();
  const deriveStart = now();
  const visibleGraph = deriveVisibleGraph(job.graph, job.mode, job.query, job.selectedId, job.largeGraphMode);
  const deriveMs = now() - deriveStart;
  const layoutStart = now();
  const graphIsLarge = visibleGraph.nodes.length > CANVAS_NODE_THRESHOLD || visibleGraph.edges.length > CANVAS_EDGE_THRESHOLD;
  const useFastLayout =
    visibleGraph.nodes.length > FAST_LAYOUT_NODE_THRESHOLD ||
    visibleGraph.edges.length > FAST_LAYOUT_EDGE_THRESHOLD ||
    (job.mode === "all" && job.largeGraphMode === "full" && graphIsLarge);
  const sceneNodes = useFastLayout
    ? fastLayout(visibleGraph.nodes, visibleGraph.quietNodeIds)
    : await elkLayout(job, visibleGraph.nodes, visibleGraph.edges, visibleGraph.quietNodeIds);
  const nodeById = new Map(sceneNodes.map((node) => [node.id, node]));
  const sceneEdges = visibleGraph.edges
    .map((edge) => toSceneEdge(edge, nodeById))
    .filter((edge): edge is SceneEdge => Boolean(edge));
  const bounds = measureBounds(sceneNodes);
  const layoutMs = now() - layoutStart;
  const lod = job.viewport ? lodForZoom(job.viewport.zoom, graphIsLarge) : graphIsLarge ? "overview" : "detail";

  return {
    nodes: sceneNodes,
    edges: sceneEdges,
    quietNodeIds: [...visibleGraph.quietNodeIds],
    hiddenNodeCount: visibleGraph.hiddenNodeCount,
    hiddenEdgeCount: visibleGraph.hiddenEdgeCount,
    lod,
    bounds,
    graphIsLarge,
    renderWithCanvas: graphIsLarge || (job.mode === "all" && job.largeGraphMode === "full"),
    usedFastLayout: useFastLayout,
    timings: {
      deriveMs,
      layoutMs,
      totalMs: now() - totalStart,
    },
  };
}

function deriveVisibleGraph(
  graph: ScanGraph | null,
  mode: Mode,
  query: string,
  selectedId: string | null,
  largeGraphMode: LargeGraphMode,
) {
  if (!graph) {
    return { nodes: [] as GraphNode[], edges: [] as GraphEdge[], quietNodeIds: new Set<string>(), hiddenNodeCount: 0, hiddenEdgeCount: 0 };
  }

  const normalizedQuery = query.trim().toLowerCase();
  const selectedNeighborhood = new Set<string>(selectedId ? [selectedId] : []);
  const expansionEdges = selectedId
    ? graph.edges.filter((edge) => expansionEdgeKinds.has(edge.kind) && (edge.source === selectedId || edge.target === selectedId))
    : [];
  for (const edge of expansionEdges) {
    selectedNeighborhood.add(edge.source);
    selectedNeighborhood.add(edge.target);
  }

  let candidateEdges: GraphEdge[];
  if (mode === "story") {
    candidateEdges = graph.edges.filter((edge) => storyEdgeKinds.has(edge.kind) || expansionEdges.includes(edge));
  } else if (mode === "all" && largeGraphMode === "guarded") {
    candidateEdges = graph.edges.filter((edge) => allGuardedEdgeKinds.has(edge.kind) || expansionEdges.includes(edge));
  } else if (mode === "all") {
    candidateEdges = graph.edges;
  } else {
    const edgeKinds = edgeKindsByMode[mode];
    candidateEdges = graph.edges.filter((edge) => edgeKinds.has(edge.kind));
  }

  const connectedNodeIds = new Set<string>();
  for (const edge of candidateEdges) {
    connectedNodeIds.add(edge.source);
    connectedNodeIds.add(edge.target);
  }

  const inMode = (node: GraphNode) => {
    if (mode === "story") {
      return routeNodeKinds.has(node.kind) || selectedNeighborhood.has(node.id) || connectedNodeIds.has(node.id);
    }
    if (mode === "routes") {
      return routeNodeKinds.has(node.kind) || connectedNodeIds.has(node.id);
    }
    if (mode === "components") {
      return ["route", "page", "layout", "component", "utility", "external", "asset"].includes(node.kind) || connectedNodeIds.has(node.id);
    }
    if (mode === "data") {
      return ["route", "page", "layout", "data", "param", "metadata"].includes(node.kind) || connectedNodeIds.has(node.id);
    }
    if (mode === "navigation") {
      return routeNodeKinds.has(node.kind) || connectedNodeIds.has(node.id);
    }
    if (mode === "all" && largeGraphMode === "guarded") {
      return routeNodeKinds.has(node.kind) || selectedNeighborhood.has(node.id) || connectedNodeIds.has(node.id);
    }
    return true;
  };

  const allModeNodes = graph.nodes.filter((node) => inMode(node) && matchesQuery(node, normalizedQuery));
  const allModeNodeIds = new Set(allModeNodes.map((node) => node.id));
  const allModeEdges = candidateEdges.filter((edge) => allModeNodeIds.has(edge.source) && allModeNodeIds.has(edge.target));
  const budgetedGraph = budgetLargeModeGraph({
    mode,
    query: normalizedQuery,
    nodes: allModeNodes,
    edges: allModeEdges,
    selectedNeighborhood,
    connectedNodeIds,
    largeGraphMode,
  });
  const nodes = budgetedGraph.nodes;
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = budgetedGraph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const quietNodeIds = new Set<string>();
  if (mode === "story" || (mode === "all" && largeGraphMode === "guarded")) {
    for (const node of nodes) {
      if (!routeNodeKinds.has(node.kind) && !selectedNeighborhood.has(node.id)) {
        quietNodeIds.add(node.id);
      }
    }
  }

  let hiddenNodeCount = 0;
  let hiddenEdgeCount = 0;
  if (mode === "all" && largeGraphMode === "guarded") {
    const fullNodes = graph.nodes.filter((node) => matchesQuery(node, normalizedQuery));
    const fullNodeIds = new Set(fullNodes.map((node) => node.id));
    const fullEdges = graph.edges.filter((edge) => fullNodeIds.has(edge.source) && fullNodeIds.has(edge.target));
    hiddenNodeCount = Math.max(0, fullNodes.length - nodes.length);
    hiddenEdgeCount = Math.max(0, fullEdges.length - edges.length);
  } else {
    hiddenNodeCount = budgetedGraph.hiddenNodeCount;
    hiddenEdgeCount = budgetedGraph.hiddenEdgeCount;
  }

  return { nodes, edges, quietNodeIds, hiddenNodeCount, hiddenEdgeCount };
}

function budgetLargeModeGraph({
  mode,
  query,
  nodes,
  edges,
  selectedNeighborhood,
  connectedNodeIds,
  largeGraphMode,
}: {
  mode: Mode;
  query: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNeighborhood: Set<string>;
  connectedNodeIds: Set<string>;
  largeGraphMode: LargeGraphMode;
}) {
  const shouldBudget =
    !query &&
    largeGraphMode === "guarded" &&
    ["components", "data", "navigation"].includes(mode) &&
    (nodes.length > LARGE_MODE_NODE_BUDGET || edges.length > LARGE_MODE_EDGE_BUDGET);

  if (!shouldBudget) {
    return { nodes, edges, hiddenNodeCount: 0, hiddenEdgeCount: 0 };
  }

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const protectedIds = new Set<string>();
  for (const node of nodes) {
    if (routeNodeKinds.has(node.kind) || selectedNeighborhood.has(node.id)) {
      protectedIds.add(node.id);
    }
  }

  const budget = Math.max(LARGE_MODE_NODE_BUDGET, protectedIds.size + 80);
  const protectedNodes = nodes.filter((node) => protectedIds.has(node.id));
  const remainingNodes = nodes
    .filter((node) => !protectedIds.has(node.id) && connectedNodeIds.has(node.id))
    .sort((a, b) => scoreNodeForMode(b, mode, degree) - scoreNodeForMode(a, mode, degree));
  const nextNodes = [...protectedNodes, ...remainingNodes.slice(0, Math.max(0, budget - protectedNodes.length))];
  const nextNodeIds = new Set(nextNodes.map((node) => node.id));
  const nextEdges = edges
    .filter((edge) => nextNodeIds.has(edge.source) && nextNodeIds.has(edge.target))
    .sort((a, b) => scoreEdgeForMode(b, mode) - scoreEdgeForMode(a, mode))
    .slice(0, LARGE_MODE_EDGE_BUDGET);

  return {
    nodes: nextNodes,
    edges: nextEdges,
    hiddenNodeCount: Math.max(0, nodes.length - nextNodes.length),
    hiddenEdgeCount: Math.max(0, edges.length - nextEdges.length),
  };
}

function scoreNodeForMode(node: GraphNode, mode: Mode, degree: Map<string, number>) {
  const base = degree.get(node.id) ?? 0;
  const kindBoost =
    mode === "components" && ["component", "page", "layout"].includes(node.kind)
      ? 80
      : mode === "data" && ["data", "metadata", "param", "page", "layout"].includes(node.kind)
        ? 80
        : mode === "navigation" && routeNodeKinds.has(node.kind)
          ? 80
          : 0;
  return base + kindBoost;
}

function scoreEdgeForMode(edge: GraphEdge, mode: Mode) {
  if (mode === "components" && edge.kind === "component-use") {
    return 3;
  }
  if (mode === "data" && ["fetch-call", "server-action"].includes(edge.kind)) {
    return 3;
  }
  if (mode === "navigation" && ["next-link", "router-navigation"].includes(edge.kind)) {
    return 3;
  }
  return 1;
}

async function elkLayout(
  job: Omit<WorkerJob, "id">,
  nodes: GraphNode[],
  edges: GraphEdge[],
  quietNodeIds: Set<string>,
) {
  const cacheKey = [
    job.graph?.generatedAt,
    job.mode,
    job.largeGraphMode,
    job.query,
    job.selectedId ?? "",
    nodes.map((node) => node.id).join("|"),
    edges.map((edge) => edge.id).join("|"),
  ].join("::");
  const cached = layoutCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const graphToLayout: ElkNode = {
    id: "root",
    children: nodes.map((node) => ({
      id: node.id,
      width: nodeSize(node).width,
      height: nodeSize(node).height,
    })),
    edges: edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  };

  const layout = await elk.layout(graphToLayout);
  const positions = new Map((layout.children ?? []).map((node) => [node.id, node]));
  const sceneNodes = nodes.map((node) => {
    const position = positions.get(node.id);
    const size = nodeSize(node);
    return toSceneNode(node, position?.x ?? 0, position?.y ?? 0, size.width, size.height, quietNodeIds.has(node.id));
  });
  layoutCache.set(cacheKey, sceneNodes);
  return sceneNodes;
}

function fastLayout(nodes: GraphNode[], quietNodeIds: Set<string>) {
  const lanes = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const lane = laneForNode(node);
    const laneNodes = lanes.get(lane) ?? [];
    laneNodes.push(node);
    lanes.set(lane, laneNodes);
  }

  const laneOrder = ["route", "layout", "page", "route-handler", "component", "data", "utility", "external", "asset", "metadata", "param"];
  const orderedLanes = [...lanes.entries()].sort((a, b) => laneOrder.indexOf(a[0]) - laneOrder.indexOf(b[0]));
  const sceneNodes: SceneNode[] = [];
  for (let laneIndex = 0; laneIndex < orderedLanes.length; laneIndex += 1) {
    const [, laneNodes] = orderedLanes[laneIndex];
    laneNodes.sort((a, b) => (a.route ?? a.file ?? a.label).localeCompare(b.route ?? b.file ?? b.label));
    for (let index = 0; index < laneNodes.length; index += 1) {
      const node = laneNodes[index];
      const size = nodeSize(node);
      const columnOffset = Math.floor(index / 36) * 360;
      const row = index % 36;
      sceneNodes.push(toSceneNode(node, laneIndex * 380 + columnOffset, row * 112, size.width, size.height, quietNodeIds.has(node.id)));
    }
  }
  return sceneNodes;
}

function toSceneNode(node: GraphNode, x: number, y: number, width: number, height: number, quiet: boolean): SceneNode {
  return {
    ...node,
    x,
    y,
    width,
    height,
    badges: getGraphNodeBadges(node),
    quiet,
  };
}

function toSceneEdge(edge: GraphEdge, nodeById: Map<string, SceneNode>) {
  const source = nodeById.get(edge.source);
  const target = nodeById.get(edge.target);
  if (!source || !target) {
    return null;
  }
  return {
    ...edge,
    sourceX: source.x + source.width,
    sourceY: source.y + source.height / 2,
    targetX: target.x,
    targetY: target.y + target.height / 2,
  };
}

function nodeSize(node: GraphNode) {
  if (node.kind === "route") {
    return { width: 280, height: 104 };
  }
  if (routeNodeKinds.has(node.kind)) {
    return { width: 220, height: 78 };
  }
  return { width: 208, height: 74 };
}

function laneForNode(node: GraphNode) {
  if (routeNodeKinds.has(node.kind)) {
    return node.kind;
  }
  return node.kind;
}

function matchesQuery(node: GraphNode, normalizedQuery: string) {
  if (!normalizedQuery) {
    return true;
  }
  return [node.label, node.route, node.file, node.kind, node.specialFile]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalizedQuery));
}

function measureBounds(nodes: SceneNode[]) {
  if (!nodes.length) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function lodForZoom(zoom: number, graphIsLarge: boolean): SceneLOD {
  if (!graphIsLarge) {
    return "detail";
  }
  if (zoom < 0.1) {
    return "cluster";
  }
  if (zoom < 0.48) {
    return "overview";
  }
  return "detail";
}

export function getGraphNodeBadges(node: GraphNode) {
  const badges: string[] = [node.kind];
  if (node.dynamic) {
    badges.push("dynamic");
  }
  if (node.specialFile) {
    badges.push(node.specialFile);
  }
  if (String(node.segment ?? "").startsWith("[[...")) {
    badges.push("optional catch-all");
  } else if (String(node.segment ?? "").startsWith("[...")) {
    badges.push("catch-all");
  }
  const metadata = node.metadata;
  if (metadata.clientComponent) {
    badges.push("client");
  }
  if (metadata.serverDirective) {
    badges.push("server");
  }
  if (metadata.usesFetch) {
    badges.push("fetch");
  }
  if (metadata.generateStaticParams) {
    badges.push("static params");
  }
  if (metadata.generateMetadata) {
    badges.push("metadata");
  }
  if (Array.isArray(metadata.slots) && metadata.slots.length) {
    badges.push("slot");
  }
  if (Array.isArray(metadata.intercepted) && metadata.intercepted.length) {
    badges.push("intercepted");
  }
  return [...new Set(badges)];
}

function now() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
