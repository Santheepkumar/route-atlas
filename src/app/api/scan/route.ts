import { NextResponse } from "next/server";
import path from "node:path";
import { createScanOptions, scanNextApp } from "@/lib/visualizer/scanner";
import type { ScanError } from "@/lib/visualizer/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const targetRoot = process.env.PAGE_VISUALS_TARGET_ROOT ?? /*turbopackIgnore: true*/ process.cwd();
    const graph = await scanNextApp(
      createScanOptions({
        targetRoot,
        scanMode: getScanMode(targetRoot),
      }),
    );
    return NextResponse.json(graph);
  } catch (error) {
    const payload: ScanError = {
      error: "Unable to scan this Next.js project.",
      details: error instanceof Error ? error.message : "Unknown scanner failure.",
    };
    return NextResponse.json(payload, { status: 500 });
  }
}

function pathIsCurrentProject(targetRoot: string) {
  return path.resolve(targetRoot) === path.resolve(/*turbopackIgnore: true*/ process.cwd());
}

function getScanMode(targetRoot: string) {
  if (process.env.PAGE_VISUALS_SCAN_MODE === "json") {
    return "json";
  }
  return pathIsCurrentProject(targetRoot) ? "local" : "external";
}
