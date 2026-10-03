/**
 * Minimal read-only client for the Escuela de Guitarristas GraphQL API.
 *
 * Only two queries are used:
 *  - the public course catalog (courses + their videos)
 *  - the authenticated user's completed video ids
 *
 * No lesson content is stored or redistributed: everything is fetched at
 * runtime with the user's own subscription token.
 */

export const DEFAULT_API_URL = "https://api.escueladeguitarristas.com/graphql";
export const SITE_URL = "https://escueladeguitarristas.com";

const CATALOG_QUERY = /* GraphQL */ `
  query edgMcpCatalog {
    courses {
      id
      name
      slug
      videosCount
      parentCourse { slug name }
      videos { id name slug duration resourcePath }
    }
  }
`;

const COMPLETED_QUERY = /* GraphQL */ `
  query edgMcpCompleted {
    userCompletedVideos { id }
  }
`;

export interface Lesson {
  id: string;
  name: string;
  slug: string;
  /** seconds */
  duration: number;
  resourcePath: string;
}

export interface Course {
  id: string;
  name: string;
  slug: string;
  videosCount: number;
  category: string | null;
  categoryName: string | null;
  lessons: Lesson[];
}

export class EdgAuthError extends Error {
  constructor(message = "EDG token rejected (expired or invalid). Log in again and update the EDG_TOKEN secret.") {
    super(message);
    this.name = "EdgAuthError";
  }
}

export class EdgApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgApiError";
  }
}

type FetchLike = typeof fetch;

export interface EdgClientOptions {
  token: string;
  apiUrl?: string;
  fetch?: FetchLike;
  /** catalog cache TTL in ms (default 6h) */
  catalogTtlMs?: number;
  now?: () => number;
}

interface GraphQLError {
  message: string;
  extensions?: { category?: string };
}

// Module-level cache: survives across requests within the same isolate.
let catalogCache: { at: number; apiUrl: string; courses: Course[] } | null = null;

export function _resetCatalogCache() {
  catalogCache = null;
}

export class EdgClient {
  private readonly token: string;
  private readonly apiUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(opts: EdgClientOptions) {
    if (!opts.token) throw new EdgAuthError("EDG_TOKEN is not configured.");
    this.token = opts.token;
    this.apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
    this.ttl = opts.catalogTtlMs ?? 6 * 60 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  private async gql<T>(query: string, auth: boolean): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "edg-mcp (+https://github.com/ipereziriarte/edg-mcp)",
    };
    if (auth) headers.authorization = `Bearer ${this.token}`;

    const res = await this.fetchImpl(this.apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    });

    if (res.status === 401 || res.status === 403) throw new EdgAuthError();
    if (!res.ok) throw new EdgApiError(`EDG API returned HTTP ${res.status}`);

    const body = (await res.json()) as { data?: T; errors?: GraphQLError[] };
    if (body.errors?.length) {
      const authErr = body.errors.find(
        (e) => e.extensions?.category === "authentication" || /unauthenticated/i.test(e.message),
      );
      if (authErr) throw new EdgAuthError();
      throw new EdgApiError(body.errors.map((e) => e.message).join("; "));
    }
    if (!body.data) throw new EdgApiError("EDG API returned no data");
    return body.data;
  }

  async getCatalog(): Promise<Course[]> {
    const t = this.now();
    if (catalogCache && catalogCache.apiUrl === this.apiUrl && t - catalogCache.at < this.ttl) {
      return catalogCache.courses;
    }
    const data = await this.gql<{
      courses: Array<{
        id: string;
        name: string;
        slug: string;
        videosCount: number;
        parentCourse: { slug: string; name: string } | null;
        videos: Lesson[];
      }>;
    }>(CATALOG_QUERY, true);

    const courses: Course[] = data.courses.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      videosCount: c.videosCount,
      category: c.parentCourse?.slug ?? null,
      categoryName: c.parentCourse?.name ?? null,
      lessons: c.videos ?? [],
    }));
    catalogCache = { at: t, apiUrl: this.apiUrl, courses };
    return courses;
  }

  async getCompletedIds(): Promise<Set<string>> {
    const data = await this.gql<{ userCompletedVideos: Array<{ id: string }> }>(COMPLETED_QUERY, true);
    return new Set(data.userCompletedVideos.map((v) => String(v.id)));
  }
}

// ---------------------------------------------------------------------------
// Pure progress helpers (easy to unit test)
// ---------------------------------------------------------------------------

export interface LessonProgress {
  number: number;
  id: string;
  name: string;
  slug: string;
  minutes: number;
  url: string;
  completed: boolean;
}

export interface CourseProgress {
  course: string;
  name: string;
  category: string | null;
  url: string;
  totalLessons: number;
  completedLessons: number;
  percent: number;
  status: "not_started" | "in_progress" | "completed";
  /** First lesson not completed, in course order. */
  nextLesson: LessonProgress | null;
  /** Lessons skipped: not completed but a later lesson is. */
  skipped: LessonProgress[];
  lessons: LessonProgress[];
}

export function courseProgress(course: Course, completed: Set<string>): CourseProgress {
  const lessons: LessonProgress[] = course.lessons.map((l, i) => ({
    number: i + 1,
    id: l.id,
    name: l.name,
    slug: l.slug,
    minutes: Math.round((l.duration ?? 0) / 60),
    url: SITE_URL + l.resourcePath,
    completed: completed.has(String(l.id)),
  }));
  const done = lessons.filter((l) => l.completed).length;
  const total = lessons.length;
  let lastDone = -1;
  lessons.forEach((l, i) => {
    if (l.completed) lastDone = i;
  });
  const skipped = lessons.filter((l, i) => !l.completed && i < lastDone);
  return {
    course: course.slug,
    name: course.name,
    category: course.category,
    url: `${SITE_URL}/cursos/${course.slug}`,
    totalLessons: total,
    completedLessons: done,
    percent: total ? Math.round((done / total) * 100) : 0,
    status: done === 0 ? "not_started" : done === total ? "completed" : "in_progress",
    nextLesson: lessons.find((l) => !l.completed) ?? null,
    skipped,
    lessons,
  };
}

export function findCourse(courses: Course[], query: string): Course | undefined {
  const q = normalize(query);
  return (
    courses.find((c) => c.slug === query) ??
    courses.find((c) => normalize(c.slug) === q) ??
    courses.find((c) => normalize(c.name) === q) ??
    courses.find((c) => normalize(c.name).includes(q))
  );
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
