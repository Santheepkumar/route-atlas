import path from "node:path";

export const ROUTING_FILE_NAMES = new Set([
  "layout",
  "page",
  "loading",
  "not-found",
  "error",
  "global-error",
  "route",
  "template",
  "default",
]);

export const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".mts",
  ".cjs",
  ".cts",
]);

export const ASSET_EXTENSIONS = new Set([
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".avif",
]);

export type SegmentInfo = {
  rawSegments: string[];
  routeSegments: string[];
  route: string;
  segment?: string;
  dynamic: boolean;
  private: boolean;
  routeGroups: string[];
  slots: string[];
  intercepted: string[];
};

export function getRouteFileKind(filePath: string) {
  const parsed = path.parse(filePath);
  if (!SOURCE_EXTENSIONS.has(parsed.ext)) {
    return undefined;
  }
  return ROUTING_FILE_NAMES.has(parsed.name) ? parsed.name : undefined;
}

export function toPosixPath(filePath: string) {
  return filePath.split(path.sep).join("/");
}

export function toRepoPath(repoRoot: string, filePath: string) {
  return toPosixPath(path.relative(repoRoot, filePath));
}

export function getNodeKindForSpecialFile(specialFile: string) {
  if (specialFile === "global-error") {
    return "error";
  }
  if (specialFile === "route") {
    return "route-handler";
  }
  return specialFile;
}

export function analyzeRouteSegments(appDir: string, dirPath: string): SegmentInfo {
  const relativeDir = path.relative(appDir, dirPath);
  const rawSegments = relativeDir ? toPosixPath(relativeDir).split("/") : [];
  const routeSegments: string[] = [];
  const routeGroups: string[] = [];
  const slots: string[] = [];
  const intercepted: string[] = [];
  let isPrivate = false;

  for (const rawSegment of rawSegments) {
    if (!rawSegment) {
      continue;
    }

    if (rawSegment.startsWith("_")) {
      isPrivate = true;
    }

    if (rawSegment.startsWith("(") && rawSegment.endsWith(")")) {
      routeGroups.push(rawSegment);
      continue;
    }

    if (rawSegment.startsWith("@")) {
      slots.push(rawSegment.slice(1));
      continue;
    }

    const interceptedSegment = unwrapInterceptedSegment(rawSegment);
    if (interceptedSegment !== rawSegment) {
      intercepted.push(rawSegment);
      if (interceptedSegment) {
        routeSegments.push(interceptedSegment);
      }
      continue;
    }

    routeSegments.push(rawSegment);
  }

  const route = routeSegments.length ? `/${routeSegments.join("/")}` : "/";
  const segment = routeSegments.at(-1) ?? "/";

  return {
    rawSegments,
    routeSegments,
    route,
    segment,
    dynamic: routeSegments.some(isDynamicSegment),
    private: isPrivate,
    routeGroups,
    slots,
    intercepted,
  };
}

export function parentRouteOf(route: string) {
  if (route === "/") {
    return undefined;
  }
  const pieces = route.split("/").filter(Boolean);
  pieces.pop();
  return pieces.length ? `/${pieces.join("/")}` : "/";
}

export function isDynamicSegment(segment: string) {
  return segment.startsWith("[") && segment.endsWith("]");
}

export function isCatchAllSegment(segment: string) {
  return segment.startsWith("[...") || segment.startsWith("[[...");
}

export function isOptionalCatchAllSegment(segment: string) {
  return segment.startsWith("[[...") && segment.endsWith("]]");
}

export function routeMatchesHref(routePattern: string, href: string) {
  const cleanHref = cleanHrefPath(href);
  if (!cleanHref || !cleanHref.startsWith("/")) {
    return false;
  }

  if (routePattern === cleanHref) {
    return true;
  }

  const patternSegments = routePattern.split("/").filter(Boolean);
  const hrefSegments = cleanHref.split("/").filter(Boolean);

  let hrefIndex = 0;
  for (const segment of patternSegments) {
    if (isOptionalCatchAllSegment(segment)) {
      return true;
    }
    if (isCatchAllSegment(segment)) {
      return hrefIndex < hrefSegments.length;
    }
    if (isDynamicSegment(segment)) {
      if (hrefIndex >= hrefSegments.length) {
        return false;
      }
      hrefIndex += 1;
      continue;
    }
    if (hrefSegments[hrefIndex] !== segment) {
      return false;
    }
    hrefIndex += 1;
  }

  return hrefIndex === hrefSegments.length;
}

export function cleanHrefPath(href: string) {
  if (!href.startsWith("/")) {
    return href;
  }
  const [withoutHash] = href.split("#");
  const [withoutQuery] = withoutHash.split("?");
  return withoutQuery || "/";
}

export function isSourceFile(filePath: string) {
  return SOURCE_EXTENSIONS.has(path.extname(filePath));
}

export function isAssetFile(filePath: string) {
  return ASSET_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function unwrapInterceptedSegment(segment: string) {
  if (segment.startsWith("(...)")) {
    return segment.slice(5);
  }

  let working = segment;
  let changed = false;
  while (working.startsWith("(.)") || working.startsWith("(..)") ) {
    if (working.startsWith("(.)")) {
      working = working.slice(3);
    } else {
      working = working.slice(4);
    }
    changed = true;
  }

  return changed ? working : segment;
}
