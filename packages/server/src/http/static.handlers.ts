import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"

import { FastifyInstance } from "fastify"
import { z } from "zod"

import { ArtifactIdSchema, VersionSchema } from "@redline/http-contracts/artifact.models"
import {
  artifactVersionAssetFile,
  artifactVersionFile,
  assetFilename,
  readArtifactMeta,
  Store,
} from "../store/artifact.store"
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

export const registerArtifactFiles = (app: FastifyInstance, store: Store): void => {
  app.get("/a/:id/:version/*", async (request, reply) => {
    const params = StaticParamsSchema.parse(request.params)
    const meta = await readArtifactMeta(store, params.id)
    const version = params.version === "current" ? meta.current : params.version
    // Empty or index.html is the version document; anything else is a
    // static asset under <version>-assets/. assetFilename rejects anything
    // that is not a single safe path segment with a known extension, so a
    // crafted wildcard can never resolve outside the artifact dir.
    const requested = params["*"]
    const assetName = requested === "" || requested === "index.html" ? undefined : assetFilename(requested)
    const target =
      assetName === undefined
        ? artifactVersionFile(store, params.id, version)
        : artifactVersionAssetFile(store, params.id, version, assetName)
    const statResult = await stat(target).catch(() => undefined)
    if (statResult?.isFile()) {
      reply.header("cache-control", "no-store").type(contentTypeForPath(target))
      return reply.send(createReadStream(target))
    }
    throw storeError("not-found", "file not found")
  })
}
