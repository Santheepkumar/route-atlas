"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphEdgeKind, GraphNodeKind } from "@/lib/visualizer/types";
import type { SceneEdge, SceneGraph, SceneNode, SceneViewport } from "@/lib/visualizer/scene";

type CanvasGraphProps = {
  scene: SceneGraph;
  selectedId: string | null;
  onSelect: (nodeId: string | null) => void;
  onViewportChange?: (viewport: SceneViewport) => void;
  onTelemetry?: (telemetry: { renderCount: number; visibleNodes: number; visibleEdges: number; drawMs: number }) => void;
};

const nodePalette: Record<GraphNodeKind, { fill: string; border: string; text: string }> = {
  route: { fill: "#ffffff", border: "#0f172a", text: "#0f172a" },
  page: { fill: "#eff6ff", border: "#2563eb", text: "#1e3a8a" },
  layout: { fill: "#fff7ed", border: "#d97706", text: "#7c2d12" },
  template: { fill: "#fff7ed", border: "#ea580c", text: "#7c2d12" },
  loading: { fill: "#f5f3ff", border: "#7c3aed", text: "#4c1d95" },
  error: { fill: "#fff1f2", border: "#e11d48", text: "#881337" },
  "not-found": { fill: "#fff1f2", border: "#f43f5e", text: "#881337" },
  default: { fill: "#f5f5f4", border: "#78716c", text: "#292524" },
  "route-handler": { fill: "#ecfeff", border: "#0891b2", text: "#164e63" },
  component: { fill: "#f0fdf4", border: "#16a34a", text: "#14532d" },
  utility: { fill: "#f8fafc", border: "#64748b", text: "#334155" },
  data: { fill: "#fff1f2", border: "#fb7185", text: "#881337" },
  asset: { fill: "#fefce8", border: "#ca8a04", text: "#713f12" },
  external: { fill: "#faf5ff", border: "#9333ea", text: "#581c87" },
  metadata: { fill: "#f0f9ff", border: "#0284c7", text: "#075985" },
  param: { fill: "#ecfeff", border: "#0e7490", text: "#155e75" },
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

export function CanvasGraph({ scene, selectedId, onSelect, onViewportChange, onTelemetry }: CanvasGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<SceneViewport>({ x: 0, y: 0, zoom: 1, width: 0, height: 0 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number; viewportX: number; viewportY: number; moved: boolean } | null>(null);
  const renderCountRef = useRef(0);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const nodeById = useMemo(() => new Map(scene.nodes.map((node) => [node.id, node])), [scene.nodes]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const start = performance.now();
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const nextWidth = Math.max(1, Math.floor(rect.width * ratio));
    const nextHeight = Math.max(1, Math.floor(rect.height * ratio));
    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    context.fillStyle = "#eef2f6";
    context.fillRect(0, 0, rect.width, rect.height);

    const viewport = { ...viewportRef.current, width: rect.width, height: rect.height };
    viewportRef.current = viewport;
    const lod = lodForZoom(viewport.zoom, scene.graphIsLarge);
    const world = {
      x: viewport.x - 240 / viewport.zoom,
      y: viewport.y - 240 / viewport.zoom,
      width: viewport.width / viewport.zoom + 480 / viewport.zoom,
      height: viewport.height / viewport.zoom + 480 / viewport.zoom,
    };
    const visibleNodes = scene.nodes.filter((node) => rectsIntersect(node, world));
    const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
    const edgeLimit = lod === "cluster" ? 1400 : lod === "overview" ? 3600 : Number.POSITIVE_INFINITY;
    let visibleEdgeCount = 0;

    context.save();
    context.translate(-viewport.x * viewport.zoom, -viewport.y * viewport.zoom);
    context.scale(viewport.zoom, viewport.zoom);
    drawGrid(context, viewport, rect.width, rect.height);

    for (const edge of scene.edges) {
      if (visibleEdgeCount >= edgeLimit) {
        break;
      }
      if (!visibleNodeIds.has(edge.source) && !visibleNodeIds.has(edge.target) && !edgeIntersects(edge, world)) {
        continue;
      }
      drawEdge(context, edge, lod);
      visibleEdgeCount += 1;
    }

    for (const node of visibleNodes) {
      drawNode(context, node, {
        selected: node.id === selectedId,
        hovered: node.id === hoveredId,
        lod,
      });
    }
    context.restore();

    renderCountRef.current += 1;
    onTelemetry?.({
      renderCount: renderCountRef.current,
      visibleNodes: visibleNodes.length,
      visibleEdges: visibleEdgeCount,
      drawMs: performance.now() - start,
    });
  }, [hoveredId, onTelemetry, scene, selectedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const resize = () => {
      fitScene(canvas, scene, viewportRef);
      onViewportChange?.(viewportRef.current);
      window.requestAnimationFrame(draw);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw, onViewportChange, scene]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, [draw]);

  const updateViewport = useCallback(
    (viewport: SceneViewport) => {
      viewportRef.current = viewport;
      onViewportChange?.(viewport);
      window.requestAnimationFrame(draw);
    },
    [draw, onViewportChange],
  );

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    const viewport = viewportRef.current;
    if (!rect) {
      return { x: 0, y: 0 };
    }
    return {
      x: viewport.x + (clientX - rect.left) / viewport.zoom,
      y: viewport.y + (clientY - rect.top) / viewport.zoom,
    };
  }, []);

  return (
    <div className="relative h-full w-full" role="application" aria-label="Route Atlas large canvas">
      <canvas
        ref={canvasRef}
        className="h-full w-full cursor-grab outline-none active:cursor-grabbing"
        tabIndex={0}
        onPointerDown={(event) => {
          const viewport = viewportRef.current;
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            viewportX: viewport.x,
            viewportY: viewport.y,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (drag) {
            const viewport = viewportRef.current;
            const dx = (event.clientX - drag.x) / viewport.zoom;
            const dy = (event.clientY - drag.y) / viewport.zoom;
            drag.moved = drag.moved || Math.abs(event.clientX - drag.x) > 3 || Math.abs(event.clientY - drag.y) > 3;
            updateViewport({ ...viewport, x: drag.viewportX - dx, y: drag.viewportY - dy });
            return;
          }
          const point = screenToWorld(event.clientX, event.clientY);
          setHoveredId(hitTest(scene.nodes, point.x, point.y)?.id ?? null);
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          dragRef.current = null;
          if (drag && !drag.moved) {
            const point = screenToWorld(event.clientX, event.clientY);
            onSelect(hitTest(scene.nodes, point.x, point.y)?.id ?? null);
          }
        }}
        onPointerLeave={() => {
          dragRef.current = null;
          setHoveredId(null);
        }}
        onWheel={(event) => {
          event.preventDefault();
          const canvas = canvasRef.current;
          const rect = canvas?.getBoundingClientRect();
          if (!rect) {
            return;
          }
          const viewport = viewportRef.current;
          const zoomFactor = Math.exp(-event.deltaY * 0.0012);
          const nextZoom = clamp(viewport.zoom * zoomFactor, 0.06, 2);
          const mouseX = event.clientX - rect.left;
          const mouseY = event.clientY - rect.top;
          const worldX = viewport.x + mouseX / viewport.zoom;
          const worldY = viewport.y + mouseY / viewport.zoom;
          updateViewport({
            ...viewport,
            zoom: nextZoom,
            x: worldX - mouseX / nextZoom,
            y: worldY - mouseY / nextZoom,
          });
        }}
      />
      <CanvasControls
        onZoomIn={() => zoomCanvas(canvasRef, viewportRef, updateViewport, 1.25)}
        onZoomOut={() => zoomCanvas(canvasRef, viewportRef, updateViewport, 0.8)}
        onFit={() => {
          const canvas = canvasRef.current;
          if (!canvas) {
            return;
          }
          fitScene(canvas, scene, viewportRef);
          updateViewport(viewportRef.current);
        }}
      />
      <CanvasHint scene={scene} />
      {selectedId ? <SelectedNodeBadge node={nodeById.get(selectedId)} /> : null}
      <div className="sr-only" aria-live="polite">
        {selectedId ? `Selected ${nodeById.get(selectedId)?.label ?? selectedId}` : `${scene.nodes.length} nodes in the route map`}
      </div>
    </div>
  );
}

function fitScene(canvas: HTMLCanvasElement, scene: SceneGraph, viewportRef: React.MutableRefObject<SceneViewport>) {
  const rect = canvas.getBoundingClientRect();
  if (!scene.nodes.length || !rect.width || !rect.height) {
    viewportRef.current = { x: 0, y: 0, zoom: 1, width: rect.width, height: rect.height };
    return;
  }
  const padding = 96;
  const minReadableZoom = scene.graphIsLarge ? 0.16 : 0.06;
  const zoom = clamp(
    Math.min((rect.width - padding) / Math.max(scene.bounds.width, 1), (rect.height - padding) / Math.max(scene.bounds.height, 1)),
    minReadableZoom,
    1.1,
  );
  viewportRef.current = {
    x: scene.bounds.x - (rect.width / zoom - scene.bounds.width) / 2,
    y: scene.bounds.y - (rect.height / zoom - scene.bounds.height) / 2,
    zoom,
    width: rect.width,
    height: rect.height,
  };
}

function drawGrid(context: CanvasRenderingContext2D, viewport: SceneViewport, width: number, height: number) {
  const step = 80;
  const minX = Math.floor(viewport.x / step) * step;
  const minY = Math.floor(viewport.y / step) * step;
  const maxX = viewport.x + width / viewport.zoom;
  const maxY = viewport.y + height / viewport.zoom;
  context.save();
  context.strokeStyle = "#dbe3ed";
  context.lineWidth = 1 / viewport.zoom;
  context.globalAlpha = viewport.zoom < 0.2 ? 0.2 : 0.35;
  for (let x = minX; x < maxX; x += step) {
    context.beginPath();
    context.moveTo(x, minY);
    context.lineTo(x, maxY);
    context.stroke();
  }
  for (let y = minY; y < maxY; y += step) {
    context.beginPath();
    context.moveTo(minX, y);
    context.lineTo(maxX, y);
    context.stroke();
  }
  context.restore();
}

function drawEdge(context: CanvasRenderingContext2D, edge: SceneEdge, lod: "cluster" | "overview" | "detail") {
  context.save();
  context.strokeStyle = edgePalette[edge.kind];
  context.lineWidth = lod === "cluster" ? 1.1 : 1.4;
  context.globalAlpha = lod === "cluster" ? 0.2 : edge.confidence === "inferred" ? 0.38 : 0.52;
  if (edge.confidence === "inferred" && lod !== "cluster") {
    context.setLineDash([6, 6]);
  }
  const delta = Math.max(48, Math.abs(edge.targetX - edge.sourceX) * 0.45);
  context.beginPath();
  context.moveTo(edge.sourceX, edge.sourceY);
  context.bezierCurveTo(edge.sourceX + delta, edge.sourceY, edge.targetX - delta, edge.targetY, edge.targetX, edge.targetY);
  context.stroke();
  context.restore();
}

function drawNode(
  context: CanvasRenderingContext2D,
  node: SceneNode,
  state: { selected: boolean; hovered: boolean; lod: "cluster" | "overview" | "detail" },
) {
  const palette = nodePalette[node.kind];
  context.save();
  context.globalAlpha = node.quiet && !state.selected ? 0.48 : 1;
  context.fillStyle = state.lod === "cluster" ? tintForKind(node.kind) : palette.fill;
  context.strokeStyle = state.selected || state.hovered ? palette.border : "#dbe3ed";
  context.lineWidth = state.selected ? 3 : 1.5;
  roundRect(context, node.x, node.y, node.width, node.height, 7);
  context.fill();
  context.stroke();
  if (state.lod !== "cluster") {
    context.fillStyle = palette.border;
    roundRect(context, node.x + 12, node.y + 14, 6, node.height - 28, 3);
    context.fill();
    context.fillStyle = palette.text;
    context.font = node.kind === "route" ? "600 14px Arial" : "600 12px Arial";
    const title = node.kind === "route" ? node.route ?? node.label : node.label;
    context.fillText(truncate(context, title, node.width - 38), node.x + 28, node.y + 28);
    if (state.lod === "detail") {
      context.fillStyle = "#64748b";
      context.font = "11px Arial";
      const subtitle = node.file ?? node.kind;
      context.fillText(truncate(context, subtitle, node.width - 38), node.x + 28, node.y + 46);
      context.fillStyle = "#94a3b8";
      context.font = "10px Arial";
      context.fillText(truncate(context, node.badges.slice(0, 3).join(" · "), node.width - 38), node.x + 28, node.y + 64);
    }
  }
  context.restore();
}

function tintForKind(kind: GraphNodeKind) {
  if (kind === "route") {
    return "#334155";
  }
  if (kind === "page") {
    return "#2563eb";
  }
  if (kind === "layout" || kind === "template") {
    return "#d97706";
  }
  if (kind === "route-handler") {
    return "#0891b2";
  }
  if (kind === "component") {
    return "#16a34a";
  }
  if (kind === "data" || kind === "metadata" || kind === "param") {
    return "#fb7185";
  }
  return "#64748b";
}

function CanvasControls({ onZoomIn, onZoomOut, onFit }: { onZoomIn: () => void; onZoomOut: () => void; onFit: () => void }) {
  return (
    <div className="absolute bottom-4 left-4 flex overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
      <button type="button" onClick={onZoomIn} className="grid size-9 place-items-center border-r border-slate-200 text-lg font-medium text-slate-700 hover:bg-slate-50" title="Zoom in">
        +
      </button>
      <button type="button" onClick={onZoomOut} className="grid size-9 place-items-center border-r border-slate-200 text-lg font-medium text-slate-700 hover:bg-slate-50" title="Zoom out">
        -
      </button>
      <button type="button" onClick={onFit} className="grid h-9 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50" title="Fit map">
        Fit
      </button>
    </div>
  );
}

function CanvasHint({ scene }: { scene: SceneGraph }) {
  if (!scene.graphIsLarge) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute right-4 top-4 max-w-xs rounded-md border border-slate-200 bg-white/92 px-3 py-2 text-xs text-slate-600 shadow-sm backdrop-blur">
      <div className="font-semibold text-slate-900">Large map view</div>
      <div className="mt-0.5">
        Drag to pan, scroll to zoom. Labels stay readable while deep nodes stay lightweight.
      </div>
    </div>
  );
}

function zoomCanvas(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  viewportRef: React.MutableRefObject<SceneViewport>,
  updateViewport: (viewport: SceneViewport) => void,
  factor: number,
) {
  const rect = canvasRef.current?.getBoundingClientRect();
  if (!rect) {
    return;
  }
  const viewport = viewportRef.current;
  const nextZoom = clamp(viewport.zoom * factor, 0.08, 2);
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;
  const worldX = viewport.x + centerX / viewport.zoom;
  const worldY = viewport.y + centerY / viewport.zoom;
  updateViewport({
    ...viewport,
    zoom: nextZoom,
    x: worldX - centerX / nextZoom,
    y: worldY - centerY / nextZoom,
  });
}

function SelectedNodeBadge({ node }: { node?: SceneNode }) {
  if (!node) {
    return null;
  }
  return (
    <div className="pointer-events-none absolute bottom-16 left-4 max-w-xs rounded-md border border-slate-200 bg-white/95 px-3 py-2 text-xs text-slate-600 shadow-sm backdrop-blur">
      <div className="font-semibold text-slate-900">{node.route ?? node.label}</div>
      <div className="mt-0.5 truncate">{node.file ?? node.kind}</div>
    </div>
  );
}

function hitTest(nodes: SceneNode[], x: number, y: number) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height) {
      return node;
    }
  }
  return null;
}

function rectsIntersect(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

function edgeIntersects(edge: SceneEdge, rect: { x: number; y: number; width: number; height: number }) {
  const minX = Math.min(edge.sourceX, edge.targetX);
  const minY = Math.min(edge.sourceY, edge.targetY);
  const maxX = Math.max(edge.sourceX, edge.targetX);
  const maxY = Math.max(edge.sourceY, edge.targetY);
  return rectsIntersect({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, rect);
}

function lodForZoom(zoom: number, graphIsLarge: boolean) {
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

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function truncate(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (context.measureText(text).width <= maxWidth) {
    return text;
  }
  let next = text;
  while (next.length > 4 && context.measureText(`${next}...`).width > maxWidth) {
    next = next.slice(0, -2);
  }
  return `${next}...`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
