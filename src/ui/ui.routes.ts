import { FastifyInstance } from "fastify"

import { IdParamsSchema } from "../api/artifact.schemas"
import { requestOrigin } from "../http/request.origin"
import { countOpenThreads, listArtifacts, readArtifactMeta, Store } from "../store/artifact.store"
import { renderGalleryPage, GalleryItem } from "./gallery.page"
import { renderSettingsPage } from "./settings.page"
import { renderShellPage, ShellData } from "./shell.page"

export const registerUiRoutes = (app: FastifyInstance, store: Store): void => {
  app.get("/", async (request, reply) => {
    const origin = requestOrigin(request)
    const metas = await listArtifacts(store)
    const items: GalleryItem[] = await Promise.all(
      metas.map(async (meta) => ({
        id: meta.id,
        title: meta.title,
        status: meta.status,
        current: meta.current,
        versionCount: meta.versions.length,
        openThreads: await countOpenThreads(store, meta.id),
        assetsCount: meta.versions.reduce((total, row) => total + (row.assets?.length ?? 0), 0),
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        reviewUrl: origin + "/a/" + meta.id,
        rawUrl: origin + "/a/" + meta.id + "/" + meta.current + "/index.html",
      })),
    )
    reply.type("text/html; charset=utf-8")
    return renderGalleryPage(items, store.home)
  })

  app.get("/settings", async (_request, reply) => {
    reply.type("text/html; charset=utf-8")
    return renderSettingsPage()
  })

  app.get("/a/:id", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params)
    const meta = await readArtifactMeta(store, id)
    const data: ShellData = {
      artifactId: meta.id,
      title: meta.title,
      prompt: meta.prompt,
      status: meta.status,
      current: meta.current,
      versions: meta.versions,
      apiBase: "/api/v1",
    }
    reply.type("text/html; charset=utf-8")
    return renderShellPage(data)
  })
}
