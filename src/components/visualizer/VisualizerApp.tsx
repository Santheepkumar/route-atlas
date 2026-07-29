"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  type Edge as FlowEdge,
  type EdgeProps,
  type Node as FlowNode,
  type NodeProps,
} from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import {
  AlertTriangle,
  Boxes,
  Braces,
  Database,
  Download,
  FileCode2,
  GitBranch,
  Link2,
  LoaderCircle,
  RefreshCw,
  Route,
  Search,
  Sparkles,
} from "lucide-react";
import type { GraphEdge, GraphEdgeKind, GraphNode, GraphNodeKind, ScanError, ScanGraph } from "@/lib/visualizer/types";

type Mode = "story" | "routes" | "components" | "data" | "navigation" | "all";
type LargeGraphMode = "guarded" | "full";
type LayoutStatus = "idle" | "pending" | "ready" | "failed";
type VisualNode = FlowNode<VisualNodeData, "visual">;
type VisualEdge = FlowEdge<VisualEdgeData, "visual">;

type VisualNodeData = {
  label: string;
  kind: GraphNodeKind;
  badges: string[];
  route?: string;
  file?: string;
  graphNode: GraphNode;
  quiet: boolean;
};

type VisualEdgeData = {
  graphEdge: GraphEdge;
  showLabel: boolean;
};

type GraphIndex = {
  nodeById: Map<string, GraphNode>;
  relationshipsByNode: Map<string, GraphEdge[]>;
};

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

const modeOptions: Array<{ id: Mode; label: string; icon: typeof Route }> = [
  { id: "story", label: "Route Story", icon: Sparkles },
  { id: "routes", label: "Routes", icon: Route },
  { id: "components", label: "Components", icon: Boxes },
  { id: "data", label: "Data", icon: Database },
  { id: "navigation", label: "Navigation", icon: Link2 },
  { id: "all", label: "All", icon: GitBranch },
];

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

const LARGE_GRAPH_NODE_THRESHOLD = 180;
const LARGE_GRAPH_EDGE_THRESHOLD = 420;
const HIDE_LABEL_EDGE_THRESHOLD = 180;
const HIDE_MINIMAP_NODE_THRESHOLD = 260;

const edgeKindsByMode: Record<Exclude<Mode, "story" | "all">, Set<GraphEdgeKind>> = {
  routes: new Set(["route-nesting", "route-owns-file", "layout-wraps", "parallel-slot", "intercepts", "route-handler"]),
  components: new Set(["imports", "component-use"]),
  data: new Set(["fetch-call", "server-action", "metadata", "dynamic-param"]),
  navigation: new Set(["next-link", "anchor-link", "router-navigation"]),
};

const nodePalette: Record<GraphNodeKind, { fill: string; border: string; text: string; chip: string }> = {
  route: { fill: "#f8fafc", border: "#0f172a", text: "#0f172a", chip: "#e2e8f0" },
  page: { fill: "#eff6ff", border: "#2563eb", text: "#1e3a8a", chip: "#dbeafe" },
  layout: { fill: "#fff7ed", border: "#d97706", text: "#7c2d12", chip: "#ffedd5" },
  template: { fill: "#fff7ed", border: "#ea580c", text: "#7c2d12", chip: "#ffedd5" },
  loading: { fill: "#f5f3ff", border: "#7c3aed", text: "#4c1d95", chip: "#ede9fe" },
  error: { fill: "#fff1f2", border: "#e11d48", text: "#881337", chip: "#ffe4e6" },
  "not-found": { fill: "#fff1f2", border: "#f43f5e", text: "#881337", chip: "#ffe4e6" },
  default: { fill: "#f5f5f4", border: "#78716c", text: "#292524", chip: "#e7e5e4" },
  "route-handler": { fill: "#ecfeff", border: "#0891b2", text: "#164e63", chip: "#cffafe" },
  component: { fill: "#f0fdf4", border: "#16a34a", text: "#14532d", chip: "#dcfce7" },
  utility: { fill: "#f8fafc", border: "#64748b", text: "#334155", chip: "#e2e8f0" },
  data: { fill: "#fff1f2", border: "#fb7185", text: "#881337", chip: "#ffe4e6" },
  asset: { fill: "#fefce8", border: "#ca8a04", text: "#713f12", chip: "#fef3c7" },
  external: { fill: "#faf5ff", border: "#9333ea", text: "#581c87", chip: "#f3e8ff" },
  metadata: { fill: "#f0f9ff", border: "#0284c7", text: "#075985", chip: "#e0f2fe" },
  param: { fill: "#ecfeff", border: "#0e7490", text: "#155e75", chip: "#cffafe" },
};

const edgePalette: Record<GraphEdgeKind, string> = {
  "route-nesting": "#0f766e",
  "route-owns-file": "#94a3b8",
  "layout-wraps": "#d97706",
  "parallel-slot": "#7c3aed",
  intercepts: "#e11d48",
  imports: "#64748b",
  "component-use": "#16a34a",
  "next-link": "#2563eb",
  "anchor-link": "#0f766e",
  "router-navigation": "#7c3aed",
  "route-handler": "#0891b2",
  "fetch-call": "#fb7185",
  "server-action": "#dc2626",
  metadata: "#0284c7",
  "dynamic-param": "#0e7490",
};

const nodeTypes = { visual: IdeNode };
const edgeTypes = { visual: IdeEdge };

export default function VisualizerApp() {
  const [graph, setGraph] = useState<ScanGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>("story");
  const [largeGraphMode, setLargeGraphMode] = useState<LargeGraphMode>("guarded");
  const [layoutStatus, setLayoutStatus] = useState<LayoutStatus>("idle");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [laidOutNodes, setLaidOutNodes] = useState<VisualNode[]>([]);
  const [isPending, startTransition] = useTransition();
  const deferredQuery = useDeferredValue(query);
  const layoutCache = useRef(new Map<string, VisualNode[]>());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/scan", { cache: "no-store" });
      const payload = (await response.json()) as ScanGraph | ScanError;
      if (!response.ok || "error" in payload) {
        throw new Error("error" in payload ? payload.details ?? payload.error : "Scan failed.");
      }
      setGraph(payload);
      layoutCache.current.clear();
      setSelectedId(null);
      setMode("story");
      setLargeGraphMode("guarded");
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Scan failed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const graphIndex = useMemo(() => buildGraphIndex(graph), [graph]);
  const selectedNode = selectedId ? graphIndex.nodeById.get(selectedId) ?? null : null;
  const selectedEdges = selectedId ? graphIndex.relationshipsByNode.get(selectedId) ?? [] : [];

  const visibleGraph = useMemo(
    () => deriveVisibleGraph(graph, mode, deferredQuery, selectedId, largeGraphMode),
    [graph, mode, deferredQuery, selectedId, largeGraphMode],
  );
  const graphIsLarge = visibleGraph.nodes.length > LARGE_GRAPH_NODE_THRESHOLD || visibleGraph.edges.length > LARGE_GRAPH_EDGE_THRESHOLD;
  const showEdgeLabels = visibleGraph.edges.length <= HIDE_LABEL_EDGE_THRESHOLD;
  const showMiniMap = visibleGraph.nodes.length <= HIDE_MINIMAP_NODE_THRESHOLD;
  const graphWorkPending = loading || isPending || layoutStatus === "pending" || query !== deferredQuery;

  const flowEdges = useMemo<VisualEdge[]>(
    () =>
      visibleGraph.edges.map((edge) => ({
        id: edge.id,
        type: "visual",
        source: edge.source,
        target: edge.target,
        label: showEdgeLabels ? edge.label : undefined,
        animated: edge.confidence === "inferred" && !graphIsLarge,
        data: { graphEdge: edge, showLabel: showEdgeLabels },
      })),
    [graphIsLarge, showEdgeLabels, visibleGraph.edges],
  );

  const flowNodes = useMemo<VisualNode[]>(
    () =>
      visibleGraph.nodes.map((node) => ({
        id: node.id,
        type: "visual",
        position: { x: 0, y: 0 },
        data: {
          label: node.label,
          kind: node.kind,
          badges: getBadges(node),
          route: node.route,
          file: node.file,
          graphNode: node,
          quiet: visibleGraph.quietNodeIds.has(node.id),
        },
      })),
    [visibleGraph.nodes, visibleGraph.quietNodeIds],
  );

  useEffect(() => {
    let cancelled = false;
    async function layoutVisibleGraph() {
      if (!flowNodes.length) {
        setLaidOutNodes([]);
        setLayoutStatus(graph ? "ready" : "idle");
        return;
      }
      const cacheKey = [
        graph?.generatedAt,
        mode,
        largeGraphMode,
        deferredQuery,
        selectedId ?? "",
        flowNodes.map((node) => node.id).join("|"),
        flowEdges.map((edge) => edge.id).join("|"),
      ].join("::");
      const cached = layoutCache.current.get(cacheKey);
      if (cached) {
        setLaidOutNodes(cached);
        setLayoutStatus("ready");
        return;
      }
      setLayoutStatus("pending");
      const graphToLayout: ElkNode = {
        id: "root",
        children: flowNodes.map((node) => ({
          id: node.id,
          width: node.data.kind === "route" ? 240 : 188,
          height: node.data.kind === "route" ? 98 : 72,
        })),
        edges: flowEdges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
      };

      try {
        const layout = await elk.layout(graphToLayout);
        const positions = new Map((layout.children ?? []).map((node) => [node.id, node]));
        if (!cancelled) {
          const nextNodes = flowNodes.map((node) => {
              const position = positions.get(node.id);
              return {
                ...node,
                position: { x: position?.x ?? 0, y: position?.y ?? 0 },
              };
            });
          layoutCache.current.set(cacheKey, nextNodes);
          setLaidOutNodes(nextNodes);
          setLayoutStatus("ready");
        }
      } catch {
        if (!cancelled) {
          setLaidOutNodes(flowNodes);
          setLayoutStatus("failed");
        }
      }
    }

    void layoutVisibleGraph();
    return () => {
      cancelled = true;
    };
  }, [deferredQuery, flowEdges, flowNodes, graph, largeGraphMode, mode, selectedId]);

  const changeMode = (nextMode: Mode) => {
    startTransition(() => {
      setMode(nextMode);
      if (nextMode !== "all") {
        setLargeGraphMode("guarded");
      }
    });
  };

  const selectNode = (nodeId: string | null) => {
    startTransition(() => {
      setSelectedId(nodeId);
    });
  };

  const showFullGraph = () => {
    startTransition(() => {
      setLargeGraphMode("full");
    });
  };

  const downloadJson = () => {
    if (!graph) {
      return;
    }
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `route-atlas-${new Date().toISOString()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <ReactFlowProvider>
      <div className="flex min-h-screen flex-col bg-[#eef2f6] text-slate-950 lg:h-screen lg:flex-row lg:overflow-hidden">
        <aside className="flex w-full shrink-0 flex-col border-b border-slate-200 bg-[#fbfcfe] lg:h-screen lg:w-[304px] lg:border-b-0 lg:border-r">
          <div className="border-b border-slate-200 p-5">
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-md bg-slate-950 text-white">
                <Braces size={19} />
              </div>
              <div>
                <h1 className="text-base font-semibold tracking-normal">Route Atlas</h1>
                <p className="mt-0.5 text-xs text-slate-500">Reusable Next.js map</p>
              </div>
            </div>
          </div>

          <div className="space-y-5 p-4">
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Search</span>
              <span className="flex h-10 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 shadow-sm focus-within:border-slate-400">
                <Search size={16} className="text-slate-500" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  placeholder="Route, file, package"
                />
              </span>
            </label>

            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Map Mode</div>
              <div className="grid gap-2">
                {modeOptions.map((option) => {
                  const Icon = option.icon;
                  const active = mode === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => changeMode(option.id)}
                      className={`flex h-10 items-center gap-2 rounded-md border px-3 text-left text-sm font-medium transition ${
                        active
                          ? "border-slate-950 bg-slate-950 text-white shadow-sm"
                          : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
                      }`}
                    >
                      <Icon size={16} />
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {graph ? (
              <>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <Metric label="Routes" value={graph.summary.routes} />
                  <Metric label="Dynamic" value={graph.summary.dynamicRoutes} />
                  <Metric label="Files" value={graph.summary.totalNodes} />
                  <Metric label="Edges" value={graph.summary.totalEdges} />
                </div>
                <div className="rounded-md border border-slate-200 bg-white p-3 text-xs text-slate-600">
                  <div className="font-semibold text-slate-800">Target</div>
                  <div className="mt-1 break-words">{graph.summary.targetRoot}</div>
                  <div className="mt-2 text-slate-400">{graph.summary.scanMode} scan</div>
                </div>
              </>
            ) : null}

            <Legend />

            {graph?.warnings.length ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                <div className="mb-1 flex items-center gap-2 font-semibold">
                  <AlertTriangle size={14} />
                  Scanner warnings
                </div>
                <ul className="space-y-1">
                  {graph.warnings.slice(0, 4).map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-[#fbfcfe] px-4 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{graph ? graph.repoRoot : "Scanning target project"}</div>
              <div className="text-xs text-slate-500">
                {graph
                  ? `${graph.framework.name} ${graph.framework.version} · ${visibleGraph.nodes.length} visible nodes · ${visibleGraph.edges.length} visible edges`
                  : "Building the map"}
              </div>
              {visibleGraph.hiddenNodeCount || visibleGraph.hiddenEdgeCount ? (
                <div className="mt-1 text-xs text-slate-400">
                  {visibleGraph.hiddenNodeCount} deep nodes hidden · {visibleGraph.hiddenEdgeCount} edges hidden
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refresh()}
                className="grid size-10 place-items-center rounded-md border border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-400"
                title="Refresh scan"
              >
                {loading ? <LoaderCircle size={17} className="animate-spin" /> : <RefreshCw size={17} />}
              </button>
              <button
                type="button"
                onClick={downloadJson}
                disabled={!graph}
                className="grid size-10 place-items-center rounded-md border border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-400 disabled:opacity-40"
                title="Export graph JSON"
              >
                <Download size={17} />
              </button>
            </div>
          </header>

          <section className="relative h-[68vh] min-h-[440px] bg-[#eef2f6] lg:min-h-0 lg:flex-1">
            {error ? (
              <div className="grid h-full place-items-center p-8">
                <div className="max-w-md rounded-md border border-rose-200 bg-white p-5 text-sm text-rose-900 shadow-sm">
                  <div className="mb-2 flex items-center gap-2 font-semibold">
                    <AlertTriangle size={17} />
                    Scan failed
                  </div>
                  {error}
                </div>
              </div>
            ) : (
              <ReactFlow
                nodes={laidOutNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                fitView
                fitViewOptions={{ padding: 0.28 }}
                minZoom={0.08}
                maxZoom={1.8}
                onNodeClick={(_, node) => selectNode(node.id)}
                onPaneClick={() => selectNode(null)}
                onlyRenderVisibleElements
                proOptions={{ hideAttribution: true }}
              >
                <Background color="#cbd5e1" gap={20} />
                {showMiniMap ? (
                  <MiniMap
                    pannable
                    zoomable
                    nodeColor={(node) => nodePalette[(node.data as VisualNodeData).kind].border}
                    maskColor="rgba(15, 23, 42, 0.08)"
                  />
                ) : null}
                <Controls />
              </ReactFlow>
            )}
            {mode === "all" && largeGraphMode === "guarded" && graph && !error ? (
              <div className="absolute left-4 top-4 max-w-sm rounded-md border border-slate-200 bg-white/95 p-3 text-xs text-slate-600 shadow-sm backdrop-blur">
                <div className="font-semibold text-slate-900">Guarded All</div>
                <div className="mt-1">
                  Showing architecture relationships first. {visibleGraph.hiddenNodeCount} deep nodes and {visibleGraph.hiddenEdgeCount} edges are hidden.
                </div>
                <button
                  type="button"
                  onClick={showFullGraph}
                  className="mt-3 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 hover:border-slate-500"
                >
                  Show full deep graph
                </button>
              </div>
            ) : null}
            {graphWorkPending && !error ? (
              <div className="absolute inset-0 grid place-items-center bg-[#eef2f6]/70 backdrop-blur-[1px]">
                <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 shadow-sm">
                  <LoaderCircle size={17} className="animate-spin" />
                  {loading ? "Scanning project" : "Preparing map"}
                </div>
              </div>
            ) : null}
          </section>
        </main>

        <aside className="flex w-full shrink-0 flex-col border-t border-slate-200 bg-[#fbfcfe] lg:h-screen lg:w-[360px] lg:border-l lg:border-t-0">
          <div className="border-b border-slate-200 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <FileCode2 size={17} />
              Inspector
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {selectedNode ? (
              <Inspector node={selectedNode} edges={selectedEdges} nodeById={graphIndex.nodeById} />
            ) : (
              <div className="space-y-3 text-sm leading-6 text-slate-500">
                <p>Select a route to unfold its components, imports, data calls, metadata, and params.</p>
                <p>Route Story keeps the map readable first; All mode shows every discovered relationship.</p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </ReactFlowProvider>
  );
}

function buildGraphIndex(graph: ScanGraph | null): GraphIndex {
  const nodeById = new Map<string, GraphNode>();
  const relationshipsByNode = new Map<string, GraphEdge[]>();
  if (!graph) {
    return { nodeById, relationshipsByNode };
  }
  for (const node of graph.nodes) {
    nodeById.set(node.id, node);
  }
  for (const edge of graph.edges) {
    const sourceEdges = relationshipsByNode.get(edge.source) ?? [];
    sourceEdges.push(edge);
    relationshipsByNode.set(edge.source, sourceEdges);
    const targetEdges = relationshipsByNode.get(edge.target) ?? [];
    targetEdges.push(edge);
    relationshipsByNode.set(edge.target, targetEdges);
  }
  return { nodeById, relationshipsByNode };
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

  const nodes = graph.nodes.filter((node) => {
    if (!inMode(node)) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    return [node.label, node.route, node.file, node.kind, node.specialFile]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalizedQuery));
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = candidateEdges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
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
  }

  return { nodes, edges, quietNodeIds, hiddenNodeCount, hiddenEdgeCount };
}

function matchesQuery(node: GraphNode, normalizedQuery: string) {
  if (!normalizedQuery) {
    return true;
  }
  return [node.label, node.route, node.file, node.kind, node.specialFile]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalizedQuery));
}

function IdeNode({ data, selected }: NodeProps<VisualNode>) {
  const palette = nodePalette[data.kind];
  const isRoute = data.kind === "route";
  return (
    <div
      className={`relative rounded-md border bg-white shadow-[0_10px_28px_rgba(15,23,42,0.08)] transition ${
        data.quiet ? "opacity-55" : "opacity-100"
      }`}
      style={{
        width: isRoute ? 240 : 188,
        borderColor: selected ? palette.border : "#dbe3ed",
        background: isRoute ? "#ffffff" : palette.fill,
        boxShadow: selected ? `0 0 0 3px ${palette.border}2b, 0 12px 30px rgba(15,23,42,0.12)` : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <Handle type="source" position={Position.Right} className="opacity-0" />
      <div className="flex items-start gap-3 p-3">
        <div className="mt-0.5 h-8 w-1.5 rounded-full" style={{ background: palette.border }} />
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: palette.border }}>
              {data.kind}
            </span>
            {data.route ? <span className="text-[10px] font-medium text-slate-400">{data.route === "/" ? "root" : "route"}</span> : null}
          </div>
          <div className="truncate text-sm font-semibold" style={{ color: palette.text }}>
            {isRoute ? data.route ?? data.label : data.label}
          </div>
          {data.file ? <div className="mt-1 truncate text-[11px] text-slate-500">{data.file}</div> : null}
          <div className="mt-2 flex flex-wrap gap-1">
            {data.badges.slice(0, isRoute ? 5 : 3).map((badge) => (
              <span key={badge} className="rounded-sm px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: palette.chip, color: palette.text }}>
                {badge}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function IdeEdge(props: EdgeProps<VisualEdge>) {
  const graphEdge = props.data?.graphEdge;
  const color = graphEdge ? edgePalette[graphEdge.kind] : "#64748b";
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });

  return (
    <>
      <BaseEdge
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth: graphEdge?.confidence === "inferred" ? 1.4 : 1.8,
          strokeDasharray: graphEdge?.confidence === "inferred" ? "5 5" : undefined,
          opacity: 0.72,
        }}
      />
      {props.label ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan rounded-sm border border-slate-200 bg-white/95 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 shadow-sm"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
          >
            {props.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3 shadow-sm">
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

function Legend() {
  const items: Array<[GraphNodeKind, string]> = [
    ["route", "Route"],
    ["layout", "Layout"],
    ["page", "Page"],
    ["route-handler", "API"],
    ["component", "Component"],
    ["data", "Data"],
  ];

  return (
    <div className="rounded-md border border-slate-200 bg-white p-3 shadow-sm">
      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Legend</div>
      <div className="grid grid-cols-2 gap-2">
        {items.map(([kind, label]) => (
          <div key={kind} className="flex items-center gap-2 text-xs text-slate-600">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: nodePalette[kind].border }} />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}

function Inspector({ node, edges, nodeById }: { node: GraphNode; edges: GraphEdge[]; nodeById: Map<string, GraphNode> }) {
  const incoming = edges.filter((edge) => edge.target === node.id);
  const outgoing = edges.filter((edge) => edge.source === node.id);

  return (
    <div className="space-y-5">
      <section>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {getBadges(node).map((badge) => (
            <span key={badge} className="rounded-sm bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700">
              {badge}
            </span>
          ))}
        </div>
        <h2 className="break-words text-lg font-semibold">{node.label}</h2>
        <p className="mt-1 text-xs text-slate-500">{node.kind}</p>
      </section>

      <section className="space-y-2">
        <SectionTitle>Overview</SectionTitle>
        <Detail label="Route" value={node.route} />
        <Detail label="File" value={node.file} />
        <Detail label="Segment" value={node.segment} />
        <Detail label="Special file" value={node.specialFile} />
      </section>

      <section>
        <SectionTitle>Relationships</SectionTitle>
        <RelationshipList title="Outgoing" edges={outgoing} empty="No outgoing relationships." nodeById={nodeById} direction="outgoing" />
        <RelationshipList title="Incoming" edges={incoming} empty="No incoming relationships." nodeById={nodeById} direction="incoming" />
      </section>

      <section>
        <SectionTitle>Metadata</SectionTitle>
        <pre className="max-h-64 overflow-auto rounded-md border border-slate-200 bg-slate-950 p-3 text-xs leading-5 text-slate-100">
          {JSON.stringify(node.metadata, null, 2)}
        </pre>
      </section>
    </div>
  );
}

function RelationshipList({
  title,
  edges,
  empty,
  nodeById,
  direction,
}: {
  title: string;
  edges: GraphEdge[];
  empty: string;
  nodeById: Map<string, GraphNode>;
  direction: "incoming" | "outgoing";
}) {
  const [expanded, setExpanded] = useState(false);
  const groups = useMemo(() => groupRelationships(edges, direction, nodeById), [direction, edges, nodeById]);
  const visibleGroups = expanded ? groups : groups.slice(0, 8);
  const hiddenCount = Math.max(0, groups.length - visibleGroups.length);

  return (
    <div className="mb-3">
      <div className="mb-1 text-xs font-semibold text-slate-500">{title}</div>
      <div className="space-y-2">
        {groups.length ? (
          <>
            {visibleGroups.map((group) => (
              <div key={group.key} className="rounded-md border border-slate-200 bg-white p-2 text-xs shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-slate-700">{group.kind}</div>
                  <div className="rounded-sm bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-500">{group.count}</div>
                </div>
                <div className="mt-1 break-words text-slate-500">{group.peerGroup}</div>
                {group.samples.length ? <div className="mt-1 truncate text-[11px] text-slate-400">{group.samples.join(" · ")}</div> : null}
              </div>
            ))}
            {hiddenCount ? (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="w-full rounded-md border border-slate-200 bg-slate-50 p-2 text-xs font-semibold text-slate-600 hover:border-slate-300"
              >
                Show {hiddenCount} more groups
              </button>
            ) : null}
          </>
        ) : (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-500">{empty}</div>
        )}
      </div>
    </div>
  );
}

function groupRelationships(edges: GraphEdge[], direction: "incoming" | "outgoing", nodeById: Map<string, GraphNode>) {
  const groups = new Map<string, { key: string; kind: GraphEdgeKind; peerGroup: string; count: number; samples: string[] }>();
  for (const edge of edges) {
    const peerId = direction === "outgoing" ? edge.target : edge.source;
    const peer = nodeById.get(peerId);
    const peerLabel = relationshipPeerLabel(peerId, peer);
    const peerGroup = relationshipPeerGroup(peerLabel);
    const key = `${edge.kind}:${peerGroup}`;
    const group = groups.get(key) ?? {
      key,
      kind: edge.kind,
      peerGroup,
      count: 0,
      samples: [],
    };
    group.count += 1;
    if (group.samples.length < 3 && !group.samples.includes(peerLabel)) {
      group.samples.push(peerLabel);
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

function relationshipPeerLabel(peerId: string, node?: GraphNode) {
  return node?.route ?? node?.file ?? node?.label ?? peerId;
}

function relationshipPeerGroup(peerLabel: string) {
  const parts = peerLabel.split("/").filter(Boolean);
  if (parts.length >= 3) {
    return `${parts.slice(0, 3).join("/")}/...`;
  }
  if (parts.length) {
    return parts.join("/");
  }
  return peerLabel;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">{children}</div>;
}

function Detail({ label, value }: { label: string; value?: string }) {
  if (!value) {
    return null;
  }
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-slate-500">{label}</div>
      <div className="break-words rounded-md border border-slate-200 bg-white p-2 text-xs text-slate-700 shadow-sm">{value}</div>
    </div>
  );
}

function getBadges(node: GraphNode) {
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
