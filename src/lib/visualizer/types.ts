export type GraphNodeKind =
  | "route"
  | "page"
  | "layout"
  | "template"
  | "loading"
  | "error"
  | "not-found"
  | "default"
  | "route-handler"
  | "component"
  | "utility"
  | "data"
  | "asset"
  | "external"
  | "metadata"
  | "param";

export type GraphEdgeKind =
  | "route-nesting"
  | "route-owns-file"
  | "layout-wraps"
  | "parallel-slot"
  | "intercepts"
  | "imports"
  | "component-use"
  | "next-link"
  | "anchor-link"
  | "router-navigation"
  | "route-handler"
  | "fetch-call"
  | "server-action"
  | "metadata"
  | "dynamic-param";

export type EdgeConfidence = "static" | "inferred";

export type GraphNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  route?: string;
  file?: string;
  segment?: string;
  dynamic?: boolean;
  specialFile?: string;
  metadata: Record<string, unknown>;
};

export type GraphEdge = {
  id: string;
  kind: GraphEdgeKind;
  source: string;
  target: string;
  label?: string;
  confidence: EdgeConfidence;
  metadata: Record<string, unknown>;
};

export type ScanGraph = {
  generatedAt: string;
  repoRoot: string;
  framework: {
    name: "next";
    version: string;
    router: "app";
  };
  summary: {
    targetRoot: string;
    appDir: string;
    scanMode: "local" | "external" | "json";
    totalNodes: number;
    totalEdges: number;
    routes: number;
    pages: number;
    layouts: number;
    routeHandlers: number;
    components: number;
    externalPackages: number;
    dynamicRoutes: number;
    warnings: number;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
};

export type ScanError = {
  error: string;
  details?: string;
};
