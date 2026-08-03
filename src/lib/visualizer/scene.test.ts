import { describe, expect, it } from "vitest";
import { deriveSceneGraph } from "./scene";
import type { GraphEdge, GraphNode, ScanGraph } from "./types";

describe("deriveSceneGraph", () => {
  it("keeps All mode guarded by default and reports hidden counts", async () => {
    const graph = createSyntheticGraph(80, 200);
    const scene = await deriveSceneGraph({
      graph,
      mode: "all",
      query: "",
      selectedId: null,
      largeGraphMode: "guarded",
    });

    expect(scene.nodes.length).toBeLessThan(graph.nodes.length);
    expect(scene.hiddenNodeCount).toBeGreaterThan(0);
    expect(scene.hiddenEdgeCount).toBeGreaterThan(0);
    expect(scene.renderWithCanvas).toBe(true);
  });

  it("uses fast layout for full deep large graphs", async () => {
    const graph = createSyntheticGraph(1200, 3200);
    const scene = await deriveSceneGraph({
      graph,
      mode: "all",
      query: "",
      selectedId: null,
      largeGraphMode: "full",
    });

    expect(scene.nodes).toHaveLength(graph.nodes.length);
    expect(scene.edges.length).toBeGreaterThan(1000);
    expect(scene.usedFastLayout).toBe(true);
    expect(scene.renderWithCanvas).toBe(true);
    expect(scene.bounds.width).toBeGreaterThan(0);
  });

  it("expands the selected node neighborhood in Route Story", async () => {
    const graph = createSyntheticGraph(16, 24);
    const selectedId = "page:/route-1";
    const scene = await deriveSceneGraph({
      graph,
      mode: "story",
      query: "",
      selectedId,
      largeGraphMode: "guarded",
    });

    expect(scene.nodes.some((node) => node.id === selectedId)).toBe(true);
    expect(scene.nodes.some((node) => node.id === "component:1")).toBe(true);
    expect(scene.edges.some((edge) => edge.kind === "component-use" && edge.source === selectedId)).toBe(true);
  });
});

function createSyntheticGraph(routeCount: number, extraEdges: number): ScanGraph {
  const nodes: GraphNode[] = [
    {
      id: "route:/",
      kind: "route",
      label: "/",
      route: "/",
      segment: "/",
      metadata: {},
    },
  ];
  const edges: GraphEdge[] = [];

  for (let index = 0; index < routeCount; index += 1) {
    const route = `/route-${index}`;
    nodes.push({
      id: `route:${route}`,
      kind: "route",
      label: route,
      route,
      segment: `route-${index}`,
      dynamic: index % 7 === 0,
      metadata: {},
    });
    nodes.push({
      id: `page:${route}`,
      kind: "page",
      label: "page.tsx",
      route,
      file: `src/app/route-${index}/page.tsx`,
      specialFile: "page",
      metadata: {},
    });
    nodes.push({
      id: `component:${index}`,
      kind: "component",
      label: `Component${index}`,
      file: `src/components/Component${index}.tsx`,
      metadata: {},
    });
    nodes.push({
      id: `utility:${index}`,
      kind: "utility",
      label: `utility-${index}`,
      file: `src/lib/utility-${index}.ts`,
      metadata: {},
    });
    edges.push(edge("route-nesting", "route:/", `route:${route}`, route));
    edges.push(edge("route-owns-file", `route:${route}`, `page:${route}`, "page"));
    edges.push(edge("component-use", `page:${route}`, `component:${index}`, `Component${index}`));
    edges.push(edge("imports", `component:${index}`, `utility:${index}`, `utility-${index}`));
  }

  for (let index = 0; index < extraEdges; index += 1) {
    const source = `utility:${index % routeCount}`;
    const target = `component:${(index * 7) % routeCount}`;
    edges.push(edge("imports", source, target, `import-${index}`));
  }

  return {
    generatedAt: "2026-08-04T00:00:00.000Z",
    repoRoot: "/fixture",
    framework: { name: "next", version: "16.2.12", router: "app" },
    summary: {
      targetRoot: "/fixture",
      appDir: "/fixture/src/app",
      scanMode: "local",
      totalNodes: nodes.length,
      totalEdges: edges.length,
      routes: routeCount + 1,
      pages: routeCount,
      layouts: 0,
      routeHandlers: 0,
      components: routeCount,
      externalPackages: 0,
      dynamicRoutes: Math.ceil(routeCount / 7),
      warnings: 0,
    },
    nodes,
    edges,
    warnings: [],
  };
}

function edge(kind: GraphEdge["kind"], source: string, target: string, label: string): GraphEdge {
  return {
    id: `${kind}:${source}->${target}:${label}`,
    kind,
    source,
    target,
    label,
    confidence: "static",
    metadata: {},
  };
}
