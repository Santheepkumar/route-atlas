# CLI and API Reference

## CLI

Start the visualizer for the current directory:

```bash
route-atlas
```

Start the visualizer for a specific project:

```bash
route-atlas ./some-next-app
```

Set host and port:

```bash
route-atlas ./some-next-app --host 127.0.0.1 --port 4000
```

Export JSON:

```bash
route-atlas scan ./some-next-app --out route-atlas.scan.json
```

Print JSON:

```bash
route-atlas scan ./some-next-app
```

Show help/version:

```bash
route-atlas --help
route-atlas --version
```

## Environment Variables

The CLI sets these internally:

```text
PAGE_VISUALS_TARGET_ROOT=/absolute/path/to/project
PAGE_VISUALS_PORT=3133
PAGE_VISUALS_SCAN_MODE=external
```

When developing the visualizer directly, you can set `PAGE_VISUALS_TARGET_ROOT` yourself:

```bash
PAGE_VISUALS_TARGET_ROOT=/path/to/next-app pnpm dev --port 3133
```

## Scan API

```http
GET /api/scan
```

Successful response:

```ts
type ScanGraph = {
  generatedAt: string
  repoRoot: string
  framework: {
    name: "next"
    version: string
    router: "app"
  }
  summary: {
    targetRoot: string
    appDir: string
    scanMode: "local" | "external" | "json"
    totalNodes: number
    totalEdges: number
    routes: number
    pages: number
    layouts: number
    routeHandlers: number
    components: number
    externalPackages: number
    dynamicRoutes: number
    warnings: number
  }
  nodes: GraphNode[]
  edges: GraphEdge[]
  warnings: string[]
}
```

Error response:

```ts
type ScanError = {
  error: string
  details?: string
}
```

## Graph Concepts

Nodes represent routes, special files, components, utilities, data calls, assets, external packages, metadata, and params.

Edges represent nesting, ownership, layout wrapping, slots, intercepts, imports, component usage, navigation, APIs, fetch calls, server actions, metadata, and dynamic params.

Edges use confidence:

- `static`: direct relationship found from routing or AST.
- `inferred`: likely relationship derived from patterns such as unresolved route hrefs.
