import { beforeEach, describe, expect, it } from "vitest";
import {
  EdgAuthError,
  EdgClient,
  _resetCatalogCache,
  courseProgress,
  findCourse,
  type Course,
} from "../src/edg.js";
import worker, { isAuthorized, type Env } from "../src/index.js";

const course = (slug: string, name: string, ids: string[], category = "ritmica"): Course => ({
  id: slug,
  name,
  slug,
  videosCount: ids.length,
  category,
  categoryName: category,
  lessons: ids.map((id, i) => ({
    id,
    name: `Lesson ${i + 1}`,
    slug: `l${i + 1}`,
    duration: 600,
    resourcePath: `/cursos/${slug}/l${i + 1}`,
  })),
});

describe("courseProgress", () => {
  it("computes next lesson, skipped lessons and status", () => {
    const c = course("solista-1", "Guitarra Solista 1", ["1", "2", "3", "4", "5"], "solista");
    const p = courseProgress(c, new Set(["1", "2", "4"]));
    expect(p.completedLessons).toBe(3);
    expect(p.percent).toBe(60);
    expect(p.status).toBe("in_progress");
    expect(p.nextLesson?.number).toBe(3);
    expect(p.skipped.map((l) => l.number)).toEqual([3]);
    expect(p.lessons[0].url).toBe("https://escueladeguitarristas.com/cursos/solista-1/l1");
  });

  it("handles not started and completed", () => {
    const c = course("x", "X", ["1", "2"]);
    expect(courseProgress(c, new Set()).status).toBe("not_started");
    const done = courseProgress(c, new Set(["1", "2"]));
    expect(done.status).toBe("completed");
    expect(done.nextLesson).toBeNull();
  });
});

describe("findCourse", () => {
  const cs = [course("ritmica-1", "Guitarra Rítmica 1", ["1"]), course("solista-1", "Guitarra Solista 1", ["2"])];
  it("matches by slug, name, accents and partial name", () => {
    expect(findCourse(cs, "ritmica-1")?.slug).toBe("ritmica-1");
    expect(findCourse(cs, "Guitarra Ritmica 1")?.slug).toBe("ritmica-1");
    expect(findCourse(cs, "solista 1")?.slug).toBe("solista-1");
    expect(findCourse(cs, "jazz")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fake EDG GraphQL API
// ---------------------------------------------------------------------------

const VALID = "edg-token";

function fakeEdg(): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    const { query } = JSON.parse(String(init?.body));
    if (auth !== `Bearer ${VALID}`) {
      return Response.json({
        errors: [{ message: "Unauthenticated.", extensions: { category: "authentication" } }],
      });
    }
    if (query.includes("userCompletedVideos")) {
      return Response.json({ data: { userCompletedVideos: [{ id: "8" }, { id: "32" }] } });
    }
    return Response.json({
      data: {
        courses: [
          {
            id: "7",
            name: "Guitarra Rítmica 1",
            slug: "ritmica-1",
            videosCount: 3,
            parentCourse: { slug: "ritmica", name: "Rítmica" },
            videos: [
              { id: "8", name: "Principios básicos", slug: "principios-basicos", duration: 805, resourcePath: "/cursos/ritmica-1/principios-basicos" },
              { id: "32", name: "Acordes G C D", slug: "acordes", duration: 707, resourcePath: "/cursos/ritmica-1/acordes" },
              { id: "33", name: "Cambios de acordes", slug: "cambios-acordes", duration: 664, resourcePath: "/cursos/ritmica-1/cambios-acordes" },
            ],
          },
        ],
      },
    });
  }) as typeof fetch;
}

describe("EdgClient", () => {
  beforeEach(() => _resetCatalogCache());

  it("reads catalog and completed ids", async () => {
    const c = new EdgClient({ token: VALID, fetch: fakeEdg() });
    const [cat, done] = await Promise.all([c.getCatalog(), c.getCompletedIds()]);
    expect(cat[0].category).toBe("ritmica");
    expect(courseProgress(cat[0], done).nextLesson?.name).toBe("Cambios de acordes");
  });

  it("raises EdgAuthError on an expired token", async () => {
    const c = new EdgClient({ token: "nope", fetch: fakeEdg() });
    await expect(c.getCompletedIds()).rejects.toBeInstanceOf(EdgAuthError);
  });
});

// ---------------------------------------------------------------------------
// Worker end-to-end (MCP over Streamable HTTP)
// ---------------------------------------------------------------------------

describe("worker", () => {
  const env: Env = { EDG_TOKEN: VALID, MCP_AUTH_TOKEN: "secret" };
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    _resetCatalogCache();
    globalThis.fetch = fakeEdg();
    return () => {
      globalThis.fetch = realFetch;
    };
  });

  const rpc = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify(body),
      }),
      env,
    );

  it("rejects requests without the shared secret", async () => {
    const res = await rpc("https://x.dev/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
  });

  it("accepts the secret as bearer header or path segment", () => {
    expect(isAuthorized(new Request("https://x.dev/mcp", { headers: { authorization: "Bearer secret" } }), env)).toBe(true);
    expect(isAuthorized(new Request("https://x.dev/mcp", { headers: { "x-api-key": "secret" } }), env)).toBe(true);
    expect(isAuthorized(new Request("https://x.dev/mcp", { headers: { "x-api-key": "nope" } }), env)).toBe(false);
    expect(isAuthorized(new Request("https://x.dev/mcp/secret"), env)).toBe(true);
    expect(isAuthorized(new Request("https://x.dev/mcp/wrong"), env)).toBe(false);
  });

  it("lists tools and calls get_course_progress", async () => {
    const list = await rpc("https://x.dev/mcp/secret", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(list.status).toBe(200);
    const tools = ((await list.json()) as any).result.tools.map((t: any) => t.name);
    expect(tools).toEqual(["list_courses", "get_course_progress", "get_next_lessons", "get_progress_overview"]);

    const call = await rpc("https://x.dev/mcp/secret", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_course_progress", arguments: { course: "Guitarra Ritmica 1" } },
    });
    const result = ((await call.json()) as any).result;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.completedLessons).toBe(2);
    expect(result.structuredContent.nextLesson.number).toBe(3);
  });

  it("surfaces an expired EDG token as AUTH_EXPIRED", async () => {
    const res = await worker.fetch(
      new Request("https://x.dev/mcp/secret", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_progress_overview", arguments: {} } }),
      }),
      { ...env, EDG_TOKEN: "expired" },
    );
    const result = ((await res.json()) as any).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^AUTH_EXPIRED/);
  });
});
