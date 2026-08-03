import { deriveSceneGraph, type SceneWorkerRequest, type WorkerResult } from "@/lib/visualizer/scene";
import type { ScanGraph } from "@/lib/visualizer/types";

let latestJobId = 0;
let activeGraph: ScanGraph | null = null;

self.onmessage = async (event: MessageEvent<SceneWorkerRequest>) => {
  if (event.data.type === "set-graph") {
    activeGraph = event.data.graph;
    return;
  }

  const job = event.data.job;
  latestJobId = job.id;
  try {
    const scene = await deriveSceneGraph({ ...job, graph: job.graph ?? activeGraph });
    if (job.id !== latestJobId) {
      return;
    }
    self.postMessage({ id: job.id, scene, status: "ready" } satisfies WorkerResult);
  } catch (error) {
    if (job.id !== latestJobId) {
      return;
    }
    const fallback = await deriveSceneGraph({ ...job, graph: job.graph ?? activeGraph, mode: "story", largeGraphMode: "guarded" });
    self.postMessage({
      id: job.id,
      scene: fallback,
      status: "failed",
      error: error instanceof Error ? error.message : "Scene layout failed.",
    } satisfies WorkerResult);
  }
};
