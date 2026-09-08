import { createReadStream, readFileSync } from "node:fs"
import { stat } from "node:fs/promises"
import { join } from "node:path"

import { FastifyInstance } from "fastify"
import { z } from "zod"

import { sendProblem } from "../api/problem.details"
import { contentTypeForPath } from "../http/static.handlers"
import { webDir } from "./paths"

const AssetParamsSchema = z.object({ "*": z.string().min(1) })

// Tiny standalone page served when the SPA was never built. Keeps --from-source
// usable without a web build; the API stays fully functional.
export const missingAssetsPage = (): string =>
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>redline</title></head>
<body style="font: 14px/1.6 system-ui, sans-serif; background: #0f1115; color: #e6e8ee; display: grid; place-items: center; min-height: 100vh; margin: 0">
<main style="max-width: 34rem; padding: 2rem">
<h1 style="color: #e5484d">redline</h1>
<p>The web UI is not built yet. The JSON API under <code>/api/v1</code> is fully usable.</p>
<p>To serve the app, run <code>bun run build:web</code> from the repo and restart the server.</p>
</main>
</body>
</html>
`

export const registerWebappRoutes = (app: FastifyInstance): void => {
  const dir = webDir()

  app.get("/assets/*", async (request, reply) => {
    if (dir === undefined) return sendProblem(reply, 404, "Not found", "web assets missing. run: bun run build:web")
    const { "*": rel } = AssetParamsSchema.parse(request.params)
    const target = join(dir, "assets", rel)
    const found = (await stat(target).catch(() => undefined))?.isFile()
    if (!found) return sendProblem(reply, 404, "Not found")
    return reply
      .header("cache-control", "public, max-age=31536000, immutable")
      .type(contentTypeForPath(target))
      .send(createReadStream(target))
  })

  app.setNotFoundHandler((request, reply) => {
    const navigates = (request.headers.accept ?? "").includes("text/html")
    const claimed = request.method === "GET" && navigates && !request.url.startsWith("/api")
    if (!claimed) {
      return sendProblem(reply, 404, "Not found", "route not found: " + (request.raw.url ?? ""))
    }
    if (dir === undefined) {
      return reply.header("cache-control", "no-store").type("text/html; charset=utf-8").send(missingAssetsPage())
    }
    const index = readFileSync(join(dir, "index.html"))
    return reply
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(index)
  })
}
