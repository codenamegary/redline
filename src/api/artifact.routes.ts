import { FastifyInstance } from "fastify"

import { requestOrigin } from "../http/request.origin"
import {
  addArtifactVersion,
  appendThread,
  appendThreadMessage,
  countOpenThreads,
  createArtifact,
  listArtifacts,
  readArtifactMeta,
  readFeedbackView,
  setArtifactStatus,
  setThreadStatus,
  Store,
} from "../store/artifact.store"
import { ArtifactMeta } from "../store/artifact.models"
import {
  AddVersionBodySchema,
  CreateArtifactBodySchema,
  CreateThreadBodySchema,
  CreateThreadMessageBodySchema,
  FeedbackQuerySchema,
  IdParamsSchema,
  PatchArtifactBodySchema,
  PatchThreadBodySchema,
  ThreadParamsSchema,
} from "./artifact.schemas"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export type ArtifactSummary = {
  id: string
  title: string
  status: string
  createdAt: string
  updatedAt: string
  current: string
  versionCount: number
  openThreads: number
  reviewUrl: string
}

const artifactApiUrl = (origin: string, id: string): string => origin + "/api/v1/artifacts/" + id

const summarizeArtifact = async (store: Store, origin: string, meta: ArtifactMeta): Promise<ArtifactSummary> => {
  return {
    id: meta.id,
    title: meta.title,
    status: meta.status,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    current: meta.current,
    versionCount: meta.versions.length,
    openThreads: await countOpenThreads(store, meta.id),
    reviewUrl: origin + "/a/" + meta.id,
  }
}

export const registerApiRoutes = (app: FastifyInstance, store: Store): void => {
  app.get("/api/v1/health", async () => ({ ok: true, service: "redline", home: store.home }))

  app.get("/api/v1/artifacts", async (request) => {
    const origin = requestOrigin(request)
    const metas = await listArtifacts(store)
    return Promise.all(metas.map((meta) => summarizeArtifact(store, origin, meta)))
  })

  app.post("/api/v1/artifacts", async (request, reply) => {
    const body = CreateArtifactBodySchema.parse(request.body)
    const meta = await createArtifact(store, body)
    const origin = requestOrigin(request)
    reply.header("location", artifactApiUrl(origin, meta.id))
    return reply.status(201).send(await summarizeArtifact(store, origin, meta))
  })

  app.get("/api/v1/artifacts/:id", async (request) => {
    const { id } = IdParamsSchema.parse(request.params)
    const meta = await readArtifactMeta(store, id)
    const origin = requestOrigin(request)
    return { ...(await summarizeArtifact(store, origin, meta)), prompt: meta.prompt, versions: meta.versions }
  })

  app.patch("/api/v1/artifacts/:id", async (request) => {
    const { id } = IdParamsSchema.parse(request.params)
    const body = PatchArtifactBodySchema.parse(request.body)
    const meta = await setArtifactStatus(store, id, body.status)
    return summarizeArtifact(store, requestOrigin(request), meta)
  })

  app.post("/api/v1/artifacts/:id/versions", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params)
    const body = AddVersionBodySchema.parse(request.body)
    const meta = await addArtifactVersion(store, id, body)
    const origin = requestOrigin(request)
    reply.header("location", artifactApiUrl(origin, meta.id))
    return reply.status(201).send(await summarizeArtifact(store, origin, meta))
  })

  app.get("/api/v1/artifacts/:id/feedback", async (request) => {
    const { id } = IdParamsSchema.parse(request.params)
    const query = FeedbackQuerySchema.parse(request.query)
    const deadline = Date.now() + (query.wait ?? 0) * 1000
    for (;;) {
      // Artifact-scoped view: every thread, open first. With ?version=vN,
      // only threads pinned on vN. view.updatedAt folds in every feedback
      // file and the meta, so long-polls wake on replies and status flips
      // no matter which version a thread lives in.
      const view = await readFeedbackView(store, id, query.version)
      const changed = query.after !== undefined && view.updatedAt > query.after
      if (changed || Date.now() >= deadline) return view
      await sleep(500)
    }
  })

  app.post("/api/v1/artifacts/:id/feedback", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params)
    const body = CreateThreadBodySchema.parse(request.body)
    const meta = await readArtifactMeta(store, id)
    const thread = await appendThread(store, id, {
      version: body.version ?? meta.current,
      anchor: body.anchor,
      body: body.body,
      author: body.author,
    })
    reply.header("location", artifactApiUrl(requestOrigin(request), id) + "/threads/" + thread.id)
    return reply.status(201).send(thread)
  })

  app.post("/api/v1/artifacts/:id/threads/:threadId/messages", async (request, reply) => {
    const { id, threadId } = ThreadParamsSchema.parse(request.params)
    const body = CreateThreadMessageBodySchema.parse(request.body)
    const thread = await appendThreadMessage(store, id, threadId, body)
    return reply.status(201).send(thread)
  })

  app.patch("/api/v1/artifacts/:id/threads/:threadId", async (request) => {
    const { id, threadId } = ThreadParamsSchema.parse(request.params)
    const body = PatchThreadBodySchema.parse(request.body)
    return setThreadStatus(store, id, threadId, body.status)
  })
}
