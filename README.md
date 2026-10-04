# edg-mcp

Unofficial [MCP](https://modelcontextprotocol.io) server that exposes **your own progress** in
[Escuela de Guitarristas](https://escueladeguitarristas.com) (EDG) courses, so an AI assistant can
see which lessons you've completed and plan your next practice sessions.

> ⚠️ **Not affiliated with Escuela de Guitarristas.** It's a personal project. It only *reads* the progress
> of the account whose token you configure, and needs an active EDG subscription. It does not
> download, store or redistribute any course content. Please be gentle with their API.

## Tools

All tools are read-only.

| Tool | What it returns |
| --- | --- |
| `get_progress_overview` | Courses in progress (with the next lesson), completed courses, total lessons completed |
| `list_courses` | Every course with % completed. Filters: `category` (`ritmica`, `solista`, `armonia`…), `status` |
| `get_course_progress` | One course, lesson by lesson: number, name, minutes, URL, `completed`, plus `nextLesson` and `skipped` lessons |
| `get_next_lessons` | The next *N* pending lessons of a course, in order (skipped ones first) |

`course` arguments accept a slug (`ritmica-1`) or a name (`Guitarra Rítmica 1`, accents optional).

If the EDG token stops working, tools return an error starting with `AUTH_EXPIRED` so the assistant
can tell you to refresh it instead of failing silently.

## How it works

EDG's web app talks to a GraphQL API (`api.escueladeguitarristas.com/graphql`) using a Bearer
token. This server sends two queries with your token:

- `courses { … videos { id name slug duration resourcePath } }`: the catalog, cached for 6 h
- `userCompletedVideos { id }`: the lessons you've marked as watched

It joins them and serves the result over MCP Streamable HTTP. It's a stateless Cloudflare Worker
with a fresh server per request and no storage.

## Setup

### 1. Get your EDG token

1. Log in at <https://escueladeguitarristas.com>.
2. Open DevTools → Console and run:
   ```js
   (await (await fetch('/api/auth/session')).json()).accessToken
   ```
3. Copy the value. Treat it like a password. At the time of writing it lasts about a year.

### 2. Deploy to Cloudflare Workers

Requires **Node.js 22.12+** (`nvm use` picks it up from `.nvmrc`).

```bash
npm install
npx wrangler login
npx wrangler secret put EDG_TOKEN        # paste the token from step 1
npx wrangler secret put MCP_AUTH_TOKEN   # any long random string, e.g. `openssl rand -hex 32`
npm run deploy
```

You'll get a URL like `https://edg-mcp.<your-subdomain>.workers.dev`.

### 3. Connect a client

The MCP endpoint is protected by `MCP_AUTH_TOKEN`. Pass it either way:

- **Header** (Claude Code, MCP Inspector, most clients): `Authorization: Bearer <MCP_AUTH_TOKEN>` → `https://…/mcp`
- **In the URL**, for clients that only take a URL, such as claude.ai custom connectors: `https://…/mcp/<MCP_AUTH_TOKEN>`

Claude Code example:

```bash
claude mcp add --transport http edg https://edg-mcp.<you>.workers.dev/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

## Development

```bash
cp .dev.vars.example .dev.vars   # fill in both values
npm run dev                      # http://localhost:8787/mcp
npm test                         # unit + end-to-end tests against a fake EDG API
npm run typecheck
```

Try it with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):
`npx @modelcontextprotocol/inspector` → Streamable HTTP → `http://localhost:8787/mcp/<MCP_AUTH_TOKEN>`.

## Security notes

- Never commit `.dev.vars`. It's in `.gitignore`. Secrets live in `wrangler secret`.
- Anyone with your `MCP_AUTH_TOKEN` can read your EDG progress. Rotate it with `wrangler secret put`.
- Anyone with your `EDG_TOKEN` can act as you on EDG. If it leaks, log out of EDG everywhere and
  change your password.

## License

[MIT](LICENSE)
