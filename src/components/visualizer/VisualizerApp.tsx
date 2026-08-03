"use client";

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from "react";
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
import { CanvasGraph } from "./CanvasGraph";
import {
  deriveSceneGraph,
  getGraphNodeBadges,
  type LargeGraphMode,
  type Mode,
  type SceneWorkerRequest,
  type SceneGraph,
  type WorkerJob,
  type WorkerResult,
} from "@/lib/visualizer/scene";
import type { GraphEdge, GraphEdgeKind, GraphNode, GraphNodeKind, ScanError, ScanGraph } from "@/lib/visualizer/types";

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

const modeOptions: Array<{ id: Mode; label: string; icon: typeof Route }> = [
  { id: "story", label: "Route Story", icon: Sparkles },
  { id: "routes", label: "Routes", icon: Route },
  { id: "components", label: "Components", icon: Boxes },
  { id: "data", label: "Data", icon: Database },
  { id: "navigation", label: "Navigation", icon: Link2 },
  { id: "all", label: "All", icon: GitBranch },
];

const HIDE_LABEL_EDGE_THRESHOLD = 180;
const HIDE_MINIMAP_NODE_THRESHOLD = 260;
const ENABLE_SCENE_WORKER = false;

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

const nodeTypes = { visual: memo(IdeNode) };
const edgeTypes = { visual: memo(IdeEdge) };

export default function VisualizerApp() {
  const [graph, setGraph] = useState<ScanGraph | null>(null);
  const [scene, setScene] = useState<SceneGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>("story");
  const [largeGraphMode, setLargeGraphMode] = useState<LargeGraphMode>("guarded");
  const [layoutStatus, setLayoutStatus] = useState<LayoutStatus>("idle");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [telemetry, setTelemetry] = useState({ renderCount: 0, visibleNodes: 0, visibleEdges: 0, drawMs: 0 });
  const deferredQuery = useDeferredValue(query);
  const workerRef = useRef<Worker | null>(null);
  const workerFailedRef = useRef(false);
  const latestJobId = useRef(0);
  const completedJobId = useRef(0);

  useEffect(() => {
    if (!ENABLE_SCENE_WORKER) {
      workerFailedRef.current = true;
      return;
    }

    try {
      workerRef.current = new Worker(new URL("./scene-worker.ts", import.meta.url));
      workerRef.current.onmessage = (event: MessageEvent<WorkerResult>) => {
        if (event.data.id !== latestJobId.current) {
          return;
        }
        completedJobId.current = event.data.id;
        setScene(event.data.scene);
        setSceneError(event.data.error ?? null);
        setLayoutStatus(event.data.status === "ready" ? "ready" : "failed");
      };
      workerRef.current.onerror = () => {
        workerFailedRef.current = true;
        workerRef.current?.terminate();
        workerRef.current = null;
      };
    } catch {
      workerFailedRef.current = true;
      workerRef.current = null;
    }
    return () => workerRef.current?.terminate();
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSceneError(null);
    try {
      const response = await fetch("/api/scan", { cache: "no-store" });
      const payload = (await response.json()) as ScanGraph | ScanError;
      if (!response.ok || "error" in payload) {
        throw new Error("error" in payload ? payload.details ?? payload.error : "Scan failed.");
      }
      setGraph(payload);
      setScene(null);
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

  useEffect(() => {
    workerRef.current?.postMessage({ type: "set-graph", graph } satisfies SceneWorkerRequest);
  }, [graph]);

  useEffect(() => {
    const worker = workerFailedRef.current ? null : workerRef.current;
    const job: WorkerJob = {
      id: latestJobId.current + 1,
      graph: worker ? null : graph,
      mode,
      query: deferredQuery,
      selectedId,
      largeGraphMode,
    };
    latestJobId.current = job.id;
    queueMicrotask(() => {
      if (latestJobId.current === job.id) {
        setLayoutStatus(graph ? "pending" : "idle");
        setSceneError(null);
      }
    });

    if (worker) {
      worker.postMessage({ type: "derive", job } satisfies SceneWorkerRequest);
      const fallbackTimer = window.setTimeout(() => {
        if (latestJobId.current !== job.id || completedJobId.current === job.id || !graph) {
          return;
        }
        workerFailedRef.current = true;
        worker.terminate();
        workerRef.current = null;
        void deriveSceneGraph({ ...job, graph })
          .then((nextScene) => {
            if (latestJobId.current === job.id) {
              setScene(nextScene);
              setSceneError("Worker layout timed out; using main-thread fallback.");
              setLayoutStatus("ready");
            }
          })
          .catch((layoutError) => {
            if (latestJobId.current === job.id) {
              setSceneError(layoutError instanceof Error ? layoutError.message : "Scene layout failed.");
              setLayoutStatus("failed");
            }
          });
      }, 4500);
      return () => window.clearTimeout(fallbackTimer);
    }

    let cancelled = false;
    void deriveSceneGraph(job)
      .then((nextScene) => {
        if (!cancelled && latestJobId.current === job.id) {
          setScene(nextScene);
          setLayoutStatus("ready");
        }
      })
      .catch((layoutError) => {
        if (!cancelled && latestJobId.current === job.id) {
          setSceneError(layoutError instanceof Error ? layoutError.message : "Scene layout failed.");
          setLayoutStatus("failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [deferredQuery, graph, largeGraphMode, mode, selectedId]);

  const graphIndex = useMemo(() => buildGraphIndex(graph), [graph]);
  const selectedNode = selectedId ? graphIndex.nodeById.get(selectedId) ?? null : null;
  const selectedEdges = selectedId ? graphIndex.relationshipsByNode.get(selectedId) ?? [] : [];
  const graphWorkPending = loading || isPending || layoutStatus === "pending" || query !== deferredQuery;
  const visibleNodeCount = scene?.nodes.length ?? 0;
  const visibleEdgeCount = scene?.edges.length ?? 0;

  const flowEdges = useMemo<VisualEdge[]>(() => {
    if (!scene) {
      return [];
    }
    const showEdgeLabels = scene.edges.length <= HIDE_LABEL_EDGE_THRESHOLD;
    return scene.edges.map((edge) => ({
      id: edge.id,
      type: "visual",
      source: edge.source,
      target: edge.target,
      label: showEdgeLabels ? edge.label : undefined,
      animated: edge.confidence === "inferred" && !scene.graphIsLarge,
      data: { graphEdge: edge, showLabel: showEdgeLabels },
    }));
  }, [scene]);

  const flowNodes = useMemo<VisualNode[]>(
    () =>
      (scene?.nodes ?? []).map((node) => ({
        id: node.id,
        type: "visual",
        position: { x: node.x, y: node.y },
        data: {
          label: node.label,
          kind: node.kind,
          badges: node.badges,
          route: node.route,
          file: node.file,
          graphNode: node,
          quiet: node.quiet,
        },
      })),
    [scene?.nodes],
  );

  const changeMode = (nextMode: Mode) => {
    startTransition(() => {
      setMode(nextMode);
      if (nextMode !== "all") {
        setLargeGraphMode("guarded");
      }
    });
  };

  const selectNode = useCallback((nodeId: string | null) => {
    startTransition(() => {
      setSelectedId(nodeId);
    });
  }, []);

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
        <LeftRail
          graph={graph}
          mode={mode}
          query={query}
          onQueryChange={setQuery}
          onModeChange={changeMode}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-[#fbfcfe] px-4 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{graph ? graph.repoRoot : "Scanning target project"}</div>
              <div className="text-xs text-slate-500">
                {graph
                  ? `${graph.framework.name} ${graph.framework.version} · ${visibleNodeCount} visible nodes · ${visibleEdgeCount} visible edges`
                  : "Building the map"}
              </div>
              {scene?.hiddenNodeCount || scene?.hiddenEdgeCount ? (
                <div className="mt-1 text-xs text-slate-400">
                  {scene.hiddenNodeCount} deep nodes hidden · {scene.hiddenEdgeCount} edges hidden
                </div>
              ) : null}
              {sceneError ? <div className="mt-1 text-xs text-amber-600">Layout fallback active: {sceneError}</div> : null}
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
            ) : scene?.renderWithCanvas ? (
              <CanvasGraph scene={scene} selectedId={selectedId} onSelect={selectNode} onTelemetry={setTelemetry} />
            ) : (
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                fitView
                fitViewOptions={{ padding: 0.28 }}
                minZoom={0.08}
                maxZoom={1.8}
                onNodeClick={(_, node) => selectNode(node.id)}
                onPaneClick={() => selectNode(null)}
                onlyRenderVisibleElements={Boolean(scene?.graphIsLarge)}
                proOptions={{ hideAttribution: true }}
              >
                <Background color="#cbd5e1" gap={20} />
                {scene && scene.nodes.length <= HIDE_MINIMAP_NODE_THRESHOLD ? (
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
            {mode === "all" && largeGraphMode === "guarded" && graph && !error && scene ? (
              <div className="absolute left-4 top-4 max-w-sm rounded-md border border-slate-200 bg-white/95 p-3 text-xs text-slate-600 shadow-sm backdrop-blur">
                <div className="font-semibold text-slate-900">Guarded All</div>
                <div className="mt-1">
                  Showing architecture relationships first. {scene.hiddenNodeCount} deep nodes and {scene.hiddenEdgeCount} edges are hidden.
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
            {process.env.NODE_ENV === "development" && scene ? (
              <div className="absolute bottom-4 right-4 rounded-md border border-slate-200 bg-white/90 px-3 py-2 text-[11px] text-slate-500 shadow-sm backdrop-blur">
                <div className="font-semibold text-slate-800">Performance</div>
                <div>scene {scene.timings.totalMs.toFixed(0)}ms · layout {scene.timings.layoutMs.toFixed(0)}ms</div>
                <div>draw {telemetry.drawMs.toFixed(1)}ms · {telemetry.visibleNodes} nodes · {telemetry.visibleEdges} edges</div>
                {scene.usedFastLayout ? <div>fast layout</div> : null}
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

        <RightInspector selectedNode={selectedNode} selectedEdges={selectedEdges} nodeById={graphIndex.nodeById} />
      </div>
    </ReactFlowProvider>
  );
}

function LeftRail({
  graph,
  mode,
  query,
  onQueryChange,
  onModeChange,
}: {
  graph: ScanGraph | null;
  mode: Mode;
  query: string;
  onQueryChange: (query: string) => void;
  onModeChange: (mode: Mode) => void;
}) {
  return (
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

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 pb-8">
        <label className="block">
          <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Search</span>
          <span className="flex h-10 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 shadow-sm focus-within:border-slate-400">
            <Search size={16} className="text-slate-500" />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
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
                  onClick={() => onModeChange(option.id)}
                  className={`flex h-10 items-center gap-2 rounded-md border px-3 text-left text-sm font-medium transition ${
                    active ? "border-slate-950 bg-slate-950 text-white shadow-sm" : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
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
  );
}

function RightInspector({
  selectedNode,
  selectedEdges,
  nodeById,
}: {
  selectedNode: GraphNode | null;
  selectedEdges: GraphEdge[];
  nodeById: Map<string, GraphNode>;
}) {
  return (
    <aside className="flex w-full shrink-0 flex-col border-t border-slate-200 bg-[#fbfcfe] lg:h-screen lg:w-[360px] lg:border-l lg:border-t-0">
      <div className="border-b border-slate-200 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <FileCode2 size={17} />
          Inspector
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {selectedNode ? (
          <Inspector node={selectedNode} edges={selectedEdges} nodeById={nodeById} />
        ) : (
          <div className="space-y-3 text-sm leading-6 text-slate-500">
            <p>Select a route to unfold its components, imports, data calls, metadata, and params.</p>
            <p>Route Story keeps the map readable first; All mode shows every discovered relationship.</p>
          </div>
        )}
      </div>
    </aside>
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

function IdeNode({ data, selected }: NodeProps<VisualNode>) {
  const palette = nodePalette[data.kind];
  const isRoute = data.kind === "route";
  return (
    <div
      className={`relative rounded-md border bg-white shadow-[0_10px_28px_rgba(15,23,42,0.08)] transition ${data.quiet ? "opacity-55" : "opacity-100"}`}
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
          {getGraphNodeBadges(node).map((badge) => (
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
