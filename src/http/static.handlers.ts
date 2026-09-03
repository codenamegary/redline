import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

import { FastifyInstance } from "fastify"
import { z } from "zod"

import { ArtifactIdSchema, VersionSchema } from "../store/artifact.models"
import { artifactVersionDir, readArtifactMeta, Store } from "../store/artifact.store"
import { storeError } from "../store/errors"

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
}

export const contentTypeForPath = (path: string): string => {
  const dot = path.lastIndexOf(".")
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase()
  return contentTypes[ext] ?? "application/octet-stream"
}

const StaticParamsSchema = z.object({
  id: ArtifactIdSchema,
  version: z.union([z.literal("current"), VersionSchema]),
  "*": z.string(),
})

const resolveFileTarget = async (baseDir: string, relativePath: string): Promise<string | null> => {
  const filePath = resolve(baseDir, relativePath)
  if (!filePath.startsWith(baseDir + sep)) return null
  const direct = await stat(filePath).catch(() => undefined)
  if (direct?.isFile()) return filePath
  if (direct?.isDirectory()) {
    const indexPath = join(filePath, "index.html")
    const index = await stat(indexPath).catch(() => undefined)
    if (index?.isFile()) return indexPath
  }
  return null
}

export const registerArtifactFiles = (app: FastifyInstance, store: Store): void => {
  app.get("/a/:id/:version/*", async (request, reply) => {
    const params = StaticParamsSchema.parse(request.params)
    const meta = await readArtifactMeta(store, params.id)
    const version = params.version === "current" ? meta.current : params.version
    const baseDir = artifactVersionDir(store, params.id, version)
    const rawSegments = params["*"].split("/")
    if (rawSegments.some((segment) => segment.includes("\0"))) {
      throw storeError("not-found", "file not found: " + params["*"])
    }
    const segments = rawSegments.filter(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    )
    const relativePath = segments.length === 0 ? "index.html" : segments.join("/")
    const target = await resolveFileTarget(baseDir, relativePath)
    if (target === null) throw storeError("not-found", "file not found: " + params["*"])
    reply.header("cache-control", "no-store").type(contentTypeForPath(target))
    return reply.send(createReadStream(target))
  })
}
