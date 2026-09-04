import { FastifyInstance } from "fastify"

import { requestOrigin } from "../http/request.origin"
import {
  approveVersion,
  appendThread,
  appendThreadMessage,
  countOpenThreads,
  createArtifact,
  listArtifacts,
  publishIteration,
  readArtifactMeta,
  readFeedbackView,
  replaceThinkingMessage,
  setThreadStatus,
  startIteration,
  Store,
} from "../store/artifact.store"
import { storeError } from "../store/errors"
import { ArtifactMeta } from "../store/artifact.models"
import { readEffectiveSettings } from "../store/settings.store"
import { createAcpAdapter } from "../worker/acp.adapter"
import { createDispatcher, workerRuntime } from "../worker/dispatcher"
import {
  AddVersionBodySchema,
  ApproveParamsSchema,
  CreateArtifactBodySchema,
  CreateThreadBodySchema,
  CreateThreadMessageBodySchema,
  FeedbackQuerySchema,
  IdParamsSchema,
  MessageParamsSchema,
  PatchMessageBodySchema,
  PatchThreadBodySchema,
  ThreadParamsSchema,
} from "./artifact.schemas"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Presence: how many wait_for_feedback long-polls are in flight per artifact.
// In memory only. Gates the thinking placeholder and the shell's Iterate
// button — the two places that must be honest about the agent listening.
const waitingAgents = new Map<string, number>()

const isAgentAttached = (id: string): boolean =>
  (waitingAgents.get(id) ?? 0) > 0 ||
  (workerRuntime.current?.presence(id).reviewerBound ?? false) ||
  (workerRuntime.current?.presence(id).workerRunning ?? false)

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
  // Server-owned agent lanes. The real ACP adapter reads lane config from
  // live settings at duty time; handlers stay no-op stubs until the
  // worker-agent loop phase wires them. Nothing calls attachReviewer or
  // attachWorker yet, so presence stays false under default settings.
  workerRuntime.current = createDispatcher({
    home: store.home,
    adapters: {
      acp: createAcpAdapter({
        getLaneConfig: async (lane) => (await readEffectiveSettings(store.home))[lane],
      }),
    },
    handlers: {
      onReplies: () => {},
      onDocument: () => {},
      onError: () => {},
    },
  })

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
    return {
      ...(await summarizeArtifact(store, origin, meta)),
      prompt: meta.prompt,
      iteratedAt: meta.iteratedAt ?? null,
      versions: meta.versions,
    }
  })

  // Submit the feedback batch: freeze open threads into a pending version
  // row and flip review -> iterating. The UI gates the button on presence,
  // but the API accepts detached iterations so they recover later.
  app.post("/api/v1/artifacts/:id/iterations", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params)
    if ((await countOpenThreads(store, id)) === 0) {
      throw storeError("unprocessable", "nothing to iterate: no open threads")
    }
    const { meta, version } = await startIteration(store, id)
    reply.header("location", artifactApiUrl(requestOrigin(request), id))
    return reply.status(201).send({
      status: meta.status,
      iteratedAt: meta.iteratedAt,
      version: version,
      openThreads: version.batch?.threadIds.length ?? 0,
    })
  })

  // Publish the pending iteration. 409 unless iterating — the gate that
  // makes live comment replies consequence-free. Success returns the
  // artifact to review.
  app.post("/api/v1/artifacts/:id/versions", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params)
    const body = AddVersionBodySchema.parse(request.body)
    const meta = await publishIteration(store, id, body)
    const origin = requestOrigin(request)
    reply.header("location", artifactApiUrl(origin, meta.id))
    return reply.status(201).send(await summarizeArtifact(store, origin, meta))
  })

  // Approval is data on a version, not a loop state: the artifact stays in
  // review and can always be iterated again.
  app.post("/api/v1/artifacts/:id/versions/:version/approve", async (request) => {
    const { id, version } = ApproveParamsSchema.parse(request.params)
    const row = await approveVersion(store, id, version)
    return row
  })

  app.get("/api/v1/artifacts/:id/feedback", async (request) => {
    const { id } = IdParamsSchema.parse(request.params)
    const query = FeedbackQuerySchema.parse(request.query)
    const waits = query.wait ?? 0
    if (waits <= 0) {
      const view = await readFeedbackView(store, id, query.version)
      return { ...view, agentAttached: isAgentAttached(id) }
    }
    const deadline = Date.now() + waits * 1000
    waitingAgents.set(id, (waitingAgents.get(id) ?? 0) + 1)
    try {
      for (;;) {
        // Artifact-scoped view: every thread, open first. With ?version=vN,
        // only threads pinned on vN. The poll wakes when updatedAt (thread
        // activity, replies, approve) or iteratedAt (Iterate) moves past
        // `after` — no matter which version a thread lives in.
        const view = await readFeedbackView(store, id, query.version)
        const changed =
          query.after !== undefined && (view.updatedAt > query.after || view.iteratedAt > query.after)
        if (changed || Date.now() >= deadline) return { ...view, agentAttached: true }
        await sleep(500)
      }
    } finally {
      waitingAgents.set(id, Math.max((waitingAgents.get(id) ?? 1) - 1, 0))
    }
  })

  app.post("/api/v1/artifacts/:id/feedback", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params)
    const body = CreateThreadBodySchema.parse(request.body)
    const meta = await readArtifactMeta(store, id)
    if (meta.status !== "review") {
      throw storeError("conflict", "artifact is iterating: new comments are locked until the agent publishes")
    }
    const thread = await appendThread(store, id, {
      version: body.version ?? meta.current,
      anchor: body.anchor,
      body: body.body,
      author: body.author,
    })
    const withPlaceholder =
      body.author === "user" && isAgentAttached(id)
        ? await appendThreadMessage(store, id, thread.id, {
            body: "…",
            author: "agent",
            kind: "thinking",
          })
        : thread
    reply.header("location", artifactApiUrl(requestOrigin(request), id) + "/threads/" + thread.id)
    return reply.status(201).send(withPlaceholder)
  })

  app.post("/api/v1/artifacts/:id/threads/:threadId/messages", async (request, reply) => {
    const { id, threadId } = ThreadParamsSchema.parse(request.params)
    const body = CreateThreadMessageBodySchema.parse(request.body)
    let thread = await appendThreadMessage(store, id, threadId, body)
    // Replies are allowed during iterating; the placeholder (a signal of
    // live attention) only makes sense while the agent is parked in review,
    // and rapid-fire comments share one pending placeholder.
    const previous = thread.messages[thread.messages.length - 2]
    if (
      body.author === "user" &&
      previous?.kind !== "thinking" &&
      (await readArtifactMeta(store, id)).status === "review" &&
      isAgentAttached(id)
    ) {
      thread = await appendThreadMessage(store, id, threadId, {
        body: "…",
        author: "agent",
        kind: "thinking",
      })
    }
    return reply.status(201).send(thread)
  })

  // Replace a thinking placeholder with the agent's real reply.
  app.patch("/api/v1/artifacts/:id/threads/:threadId/messages/:messageId", async (request) => {
    const { id, threadId, messageId } = MessageParamsSchema.parse(request.params)
    const body = PatchMessageBodySchema.parse(request.body)
    return replaceThinkingMessage(store, id, threadId, messageId, body.body)
  })

  app.patch("/api/v1/artifacts/:id/threads/:threadId", async (request) => {
    const { id, threadId } = ThreadParamsSchema.parse(request.params)
    const body = PatchThreadBodySchema.parse(request.body)
    if ((await readArtifactMeta(store, id)).status !== "review") {
      throw storeError("conflict", "threads are locked while the agent is iterating")
    }
    return setThreadStatus(store, id, threadId, body.status)
  })
}
