import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeRouteSegments, parentRouteOf, routeMatchesHref } from "./route-utils";

const appDir = path.join("/repo", "src", "app");

describe("route utilities", () => {
  it("omits route groups and preserves nested dynamic route segments", () => {
    const result = analyzeRouteSegments(appDir, path.join(appDir, "(shop)", "products", "[id]"));

    expect(result.route).toBe("/products/[id]");
    expect(result.routeGroups).toEqual(["(shop)"]);
    expect(result.dynamic).toBe(true);
  });

  it("marks private folders as non-routable", () => {
    const result = analyzeRouteSegments(appDir, path.join(appDir, "dashboard", "_components"));

    expect(result.private).toBe(true);
    expect(result.route).toBe("/dashboard/_components");
  });

  it("omits parallel slots from the URL but records them", () => {
    const result = analyzeRouteSegments(appDir, path.join(appDir, "dashboard", "@analytics", "views"));

    expect(result.route).toBe("/dashboard/views");
    expect(result.slots).toEqual(["analytics"]);
  });

  it("unwraps intercepted route markers into the target segment", () => {
    const result = analyzeRouteSegments(appDir, path.join(appDir, "feed", "@modal", "(..)photo", "[id]"));

    expect(result.route).toBe("/feed/photo/[id]");
    expect(result.intercepted).toEqual(["(..)photo"]);
  });

  it("matches static, dynamic, catch-all, and optional catch-all hrefs", () => {
    expect(routeMatchesHref("/blog/[slug]", "/blog/hello")).toBe(true);
    expect(routeMatchesHref("/docs/[...slug]", "/docs/a/b")).toBe(true);
    expect(routeMatchesHref("/shop/[[...slug]]", "/shop")).toBe(true);
    expect(routeMatchesHref("/shop/[[...slug]]", "/shop/a/b")).toBe(true);
    expect(routeMatchesHref("/blog/[slug]", "/blog")).toBe(false);
  });

  it("finds parent routes", () => {
    expect(parentRouteOf("/dashboard/settings")).toBe("/dashboard");
    expect(parentRouteOf("/dashboard")).toBe("/");
    expect(parentRouteOf("/")).toBeUndefined();
  });
});
