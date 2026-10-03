import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EdgAuthError, EdgClient, courseProgress, findCourse, type CourseProgress } from "./edg.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(err: unknown) {
  const message =
    err instanceof EdgAuthError
      ? `AUTH_EXPIRED: ${err.message}`
      : `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function summary(p: CourseProgress) {
  const { lessons: _lessons, skipped, nextLesson, ...rest } = p;
  return {
    ...rest,
    nextLesson: nextLesson && { number: nextLesson.number, name: nextLesson.name, url: nextLesson.url },
    skippedLessons: skipped.map((l) => l.number),
  };
}

export function buildServer(client: EdgClient): McpServer {
  const server = new McpServer({ name: "edg-mcp", version: "0.1.0" });

  server.registerTool(
    "list_courses",
    {
      title: "List courses",
      description:
        "List Escuela de Guitarristas courses with the user's progress in each. Optionally filter by category slug (e.g. 'ritmica', 'solista', 'armonia') or by status.",
      inputSchema: {
        category: z.string().optional().describe("Category slug, e.g. 'ritmica' or 'solista'"),
        status: z.enum(["not_started", "in_progress", "completed"]).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ category, status }) => {
      try {
        const [courses, done] = await Promise.all([client.getCatalog(), client.getCompletedIds()]);
        const rows = courses
          .filter((c) => !category || c.category === category)
          .map((c) => summary(courseProgress(c, done)))
          .filter((c) => !status || c.status === status);
        return json({ courses: rows });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_course_progress",
    {
      title: "Get course progress",
      description:
        "Lesson-by-lesson progress for one course: every lesson in order with its number, name, duration, URL and whether it is completed, plus the next pending lesson and any skipped lessons.",
      inputSchema: {
        course: z.string().describe("Course slug (e.g. 'ritmica-1') or name (e.g. 'Guitarra Solista 1')"),
      },
      annotations: READ_ONLY,
    },
    async ({ course }) => {
      try {
        const [courses, done] = await Promise.all([client.getCatalog(), client.getCompletedIds()]);
        const c = findCourse(courses, course);
        if (!c) return fail(new Error(`Course not found: ${course}. Use list_courses to see slugs.`));
        return json(courseProgress(c, done));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_next_lessons",
    {
      title: "Get next lessons",
      description:
        "The next N pending lessons of a course, in course order (skipped earlier lessons come first). Use this to plan upcoming practice sessions.",
      inputSchema: {
        course: z.string().describe("Course slug or name"),
        count: z.number().int().min(1).max(30).default(5),
      },
      annotations: READ_ONLY,
    },
    async ({ course, count }) => {
      try {
        const [courses, done] = await Promise.all([client.getCatalog(), client.getCompletedIds()]);
        const c = findCourse(courses, course);
        if (!c) return fail(new Error(`Course not found: ${course}. Use list_courses to see slugs.`));
        const p = courseProgress(c, done);
        return json({
          course: p.course,
          name: p.name,
          completedLessons: p.completedLessons,
          totalLessons: p.totalLessons,
          next: p.lessons.filter((l) => !l.completed).slice(0, count),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_progress_overview",
    {
      title: "Get progress overview",
      description:
        "One-call summary of where the user is: courses in progress (with next lesson), completed courses, and total lessons completed.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const [courses, done] = await Promise.all([client.getCatalog(), client.getCompletedIds()]);
        const all = courses.map((c) => courseProgress(c, done));
        return json({
          totalCompletedLessons: done.size,
          inProgress: all.filter((p) => p.status === "in_progress").map(summary),
          completed: all.filter((p) => p.status === "completed").map((p) => ({ course: p.course, name: p.name })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
