import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanNextApp } from "./scanner";

let fixtureRoot: string;

describe("scanNextApp", () => {
  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "route-atlas-"));
    await writeFixture(fixtureRoot);
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { force: true, recursive: true });
  });

  it("builds route, special file, import, link, fetch, and metadata relationships", async () => {
    const graph = await scanNextApp(fixtureRoot);

    expect(graph.framework.router).toBe("app");
    expect(graph.summary.targetRoot).toBe(fixtureRoot);
    expect(graph.summary.appDir).toBe(path.join(fixtureRoot, "src", "app"));
    expect(graph.summary.scanMode).toBe("local");
    expect(graph.nodes.some((node) => node.id === "route:/")).toBe(true);
    expect(graph.nodes.some((node) => node.id === "route:/blog/[slug]" && node.dynamic)).toBe(true);
    expect(graph.nodes.some((node) => node.kind === "page" && node.route === "/blog/[slug]")).toBe(true);
    expect(graph.nodes.some((node) => node.kind === "route-handler" && node.route === "/api/posts")).toBe(true);

    expect(graph.edges.some((edge) => edge.kind === "route-nesting" && edge.source === "route:/blog")).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "imports" && edge.label === "@/components/Card")).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "component-use" && edge.label === "Card")).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "next-link" && edge.label === "/blog/first")).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "fetch-call" && edge.label === "fetch")).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "metadata")).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "dynamic-param")).toBe(true);
  });

  it("honors PAGE_VISUALS_TARGET_ROOT when no scan root is passed", async () => {
    const previousTargetRoot = process.env.PAGE_VISUALS_TARGET_ROOT;
    process.env.PAGE_VISUALS_TARGET_ROOT = fixtureRoot;
    try {
      const graph = await scanNextApp();
      expect(graph.summary.targetRoot).toBe(fixtureRoot);
    } finally {
      if (previousTargetRoot) {
        process.env.PAGE_VISUALS_TARGET_ROOT = previousTargetRoot;
      } else {
        delete process.env.PAGE_VISUALS_TARGET_ROOT;
      }
    }
  });

  it("ignores generated folders plus test and story files while preserving imported assets", async () => {
    const graph = await scanNextApp(fixtureRoot);

    expect(graph.nodes.some((node) => node.file?.startsWith("storybook-static/"))).toBe(false);
    expect(graph.nodes.some((node) => node.file?.includes("Card.stories.tsx"))).toBe(false);
    expect(graph.nodes.some((node) => node.file?.includes("Card.test.tsx"))).toBe(false);
    expect(graph.nodes.some((node) => node.file?.startsWith("coverage/"))).toBe(false);
    expect(graph.nodes.some((node) => node.id === "asset:src/components/icon.svg")).toBe(true);
    expect(graph.warnings).toContain("Ignored generated folder: storybook-static");
    expect(graph.warnings).toContain("Ignored generated folder: coverage");
  });
});

async function writeFixture(root: string) {
  await fs.mkdir(path.join(root, "src", "app", "blog", "[slug]"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "app", "api", "posts"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "components"), { recursive: true });
  await fs.mkdir(path.join(root, "storybook-static", "assets"), { recursive: true });
  await fs.mkdir(path.join(root, "coverage"), { recursive: true });

  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      dependencies: {
        next: "16.2.12",
      },
    }),
  );
  await fs.writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        paths: {
          "@/*": ["./src/*"],
        },
      },
    }),
  );
  await fs.writeFile(
    path.join(root, "src", "components", "Card.tsx"),
    "import icon from './icon.svg'\nexport function Card({ children }: { children: React.ReactNode }) { return <article data-icon={icon}>{children}</article> }\n",
  );
  await fs.writeFile(path.join(root, "src", "components", "icon.svg"), "<svg />\n");
  await fs.writeFile(path.join(root, "src", "components", "Card.stories.tsx"), "export default { component: 'Card' }\n");
  await fs.writeFile(path.join(root, "src", "components", "Card.test.tsx"), "import { Card } from './Card'\n");
  await fs.writeFile(path.join(root, "storybook-static", "assets", "bundle.js"), "import './chunk.js'; export const generated = true;\n");
  await fs.writeFile(path.join(root, "coverage", "coverage.js"), "export const generated = true;\n");
  await fs.writeFile(
    path.join(root, "src", "app", "layout.tsx"),
    "export const metadata = { title: 'Fixture' }\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html> }\n",
  );
  await fs.writeFile(
    path.join(root, "src", "app", "page.tsx"),
    "import Link from 'next/link'\nimport { Card } from '@/components/Card'\nexport default function Page() { return <Card><Link href=\"/blog/first\">First</Link></Card> }\n",
  );
  await fs.writeFile(
    path.join(root, "src", "app", "blog", "[slug]", "page.tsx"),
    "export async function generateMetadata() { return { title: 'Post' } }\nexport default async function Page({ params }: PageProps<'/blog/[slug]'>) { const { slug } = await params; await fetch('https://example.com/posts/' + slug); return <h1>{slug}</h1> }\n",
  );
  await fs.writeFile(
    path.join(root, "src", "app", "api", "posts", "route.ts"),
    "export async function GET() { return Response.json([]) }\n",
  );
}
