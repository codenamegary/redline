import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { FastifyInstance } from "fastify"

import { requestOrigin } from "../http/request.origin"
import {
  approveVersion,
  appendThread,
  appendThreadMessage,
  artifactVersionDir,
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
import { ArtifactMeta, ArtifactVersion, Thread } from "../store/artifact.models"
import { readEffectiveSettings } from "../store/settings.store"
import { createAcpAdapter } from "../worker/acp.adapter"
import { createDispatcher, DispatcherAdapters, workerRuntime } from "../worker/dispatcher"
import { DutyResult, Lane, SeedSpec, ThreadRef } from "../worker/host.adapter"
import { createOpenCodeSdkAdapter } from "../worker/opencode.sdk.adapter"
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

// A configured reviewer answers comments even before its bind lands (fresh
// daemon, settings flipped after create), so placeholder placement must not
// depend on live presence alone.
const reviewerConfigured = async (store: Store): Promise<boolean> =>
  (await readEffectiveSettings(store.home)).reviewer.adapter !== "none"

// Per-lane presence for the feedback view, so the shell can say which lane
// is actually live instead of collapsing everything into agentAttached.
const lanePresence = (id: string): { reviewerAttached: boolean; workerRunning: boolean } => {
  const presence = workerRuntime.current?.presence(id)
  return {
    reviewerAttached: presence?.reviewerBound === true,
    workerRunning: presence?.workerRunning === true,
  }
}

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
  // Lane status contract consumed by plugins (Phase 5). reviewer is "starting"
  // between create and the async bind, "idle" once bound, "none" when the
  // configured reviewer adapter is "none". worker reads "idle" whenever a
  // worker adapter is configured, "none" otherwise.
  reviewer: "none" | "starting" | "idle"
  worker: "none" | "idle"
}

const artifactApiUrl = (origin: string, id: string): string => origin + "/api/v1/artifacts/" + id

const summarizeArtifact = async (store: Store, origin: string, meta: ArtifactMeta): Promise<ArtifactSummary> => {
  const settings = await readEffectiveSettings(store.home)
  const presence = workerRuntime.current?.presence(meta.id)
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
    reviewer:
      settings.reviewer.adapter === "none"
        ? "none"
        : presence?.reviewerBound === true
          ? "idle"
          : "starting",
    worker: settings.worker.adapter === "none" ? "none" : "idle",
  }
}

// Attaching reads settings on a background task, so the bind lands a tick
// later. Dispatch helpers give it this long to land before enqueueing.
const laneBindTimeoutMs = 2000

const waitForLaneBind = async (artifactId: string, lane: Lane): Promise<boolean> => {
  const deadline = Date.now() + laneBindTimeoutMs
  for (;;) {
    const presence = workerRuntime.current?.presence(artifactId)
    if ((lane === "reviewer" ? presence?.reviewerBound : presence?.workerBound) === true) return true
    if (Date.now() >= deadline) return false
    await sleep(5)
  }
}

// Open threads whose LAST message is a thinking placeholder: the unanswered
// questions a reply duty must fill.
const thinkingTargets = (threads: Thread[]): ThreadRef[] =>
  threads
    .filter((thread) => thread.status === "open")
    .flatMap((thread) => {
      const last = thread.messages[thread.messages.length - 1]
      return last !== undefined && last.kind === "thinking"
        ? [{ threadId: thread.id, messageId: last.id }]
        : []
    })

const collectTargets = async (store: Store, artifactId: string): Promise<ThreadRef[]> =>
  thinkingTargets((await readFeedbackView(store, artifactId)).threads)

// Placeholders can vanish mid-duty (thread resolved, artifact approved);
// a missed patch is swallowed per item, never fatal to the batch.
const tryPatchTarget = async (
  store: Store,
  artifactId: string,
  target: ThreadRef,
  body: string,
): Promise<boolean> => {
  try {
    await replaceThinkingMessage(store, artifactId, target.threadId, target.messageId, body)
    return true
  } catch {
    return false
  }
}

// Every origin ping reads origin (plus title/current) from fresh meta at
// send time, so approvals and publishes that raced the duty still read right.
const notifyOriginLine = async (
  store: Store,
  artifactId: string,
  line: (meta: ArtifactMeta) => string,
): Promise<void> => {
  const meta = await readArtifactMeta(store, artifactId).catch(() => undefined)
  if (meta === undefined) return
  await workerRuntime.current?.notifyOrigin(artifactId, meta.origin, line(meta))
}

// Fire-and-forget reviewer dispatch, called at the end of the comment
// routes after the response payload is built. Never awaited by the route.
const dispatchReplies = async (store: Store, artifactId: string): Promise<void> => {
  const dispatcher = workerRuntime.current
  if (dispatcher === undefined) return
  const settings = await readEffectiveSettings(store.home)
  if (settings.reviewer.adapter === "none") return
  if (!dispatcher.presence(artifactId).reviewerBound) {
    // Comment without a prior attach (settings flipped after create, server
    // restarted): re-attach and give the async bind a beat before enqueue.
    dispatcher.attachReviewer(artifactId)
    if (!(await waitForLaneBind(artifactId, "reviewer"))) {
      // The bind never landed (adapter missing from the registry, broken
      // command): fail the lane so outstanding thinking placeholders are
      // patched with the unavailable text instead of dangling forever.
      await dispatcher.fail(artifactId, "reviewer", "reviewer lane failed to start")
      return
    }
  }
  const meta = await readArtifactMeta(store, artifactId)
  const view = await readFeedbackView(store, artifactId)
  const openThreads = view.threads.filter((thread) => thread.status === "open")
  // Self-heal: a comment can land while the reviewer looks unattached (bind
  // race, settings flip mid-request) and skip the route's placeholder gate.
  // Every open review-status thread that still ends in a user message gets
  // its placeholder here, then joins the duty.
  if (meta.status === "review") {
    for (const thread of openThreads) {
      const last = thread.messages[thread.messages.length - 1]
      if (last !== undefined && last.author === "user" && last.kind === "text") {
        await appendThreadMessage(store, artifactId, thread.id, {
          body: "…",
          author: "agent",
          kind: "thinking",
        })
      }
    }
  }
  const targets = await collectTargets(store, artifactId)
  if (targets.length === 0) return
  dispatcher.enqueueReply(artifactId, {
    lane: "reviewer",
    promptTemplate: settings.prompts.reviewer,
    brief: meta.prompt,
    title: meta.title,
    version: meta.current,
    threads: openThreads,
    targets: targets,
  })
}

const handleReplies = async (
  store: Store,
  artifactId: string,
  items: { threadId: string; messageId: string; body: string }[],
): Promise<void> => {
  let applied = 0
  for (const item of items) {
    if (await tryPatchTarget(store, artifactId, item, item.body)) applied += 1
  }
  if (applied === 0) return
  await notifyOriginLine(
    store,
    artifactId,
    (meta) => "replied to " + String(applied) + " thread(s) on " + meta.title + " (" + meta.current + ")",
  )
}

const handleDocument = async (
  store: Store,
  artifactId: string,
  doc: DutyResult & { kind: "document" },
): Promise<void> => {
  const meta = await readArtifactMeta(store, artifactId)
  // The artifact moved on while the duty flew (user approved or published
  // manually): the document is stale, drop it.
  if (meta.status !== "iterating") return
  await publishIteration(store, artifactId, { html: doc.html, note: doc.note })
  await notifyOriginLine(
    store,
    artifactId,
    (fresh) => "published " + fresh.current + " of " + fresh.title + " — " + (doc.note ?? ""),
  )
}

const handleError = async (store: Store, artifactId: string, lane: Lane, detail: string): Promise<void> => {
  if (lane === "reviewer") {
    // Patch every outstanding placeholder so no "…" dangles forever.
    const targets = await collectTargets(store, artifactId)
    for (const target of targets) {
      await tryPatchTarget(store, artifactId, target, "reviewer unavailable: " + detail)
    }
    return
  }
  // Worker errors mutate nothing: the artifact stays iterating so the user
  // can re-Iterate or the fallback agent can publish.
  await notifyOriginLine(store, artifactId, () => "worker failed: " + detail)
}

// Lane debug view for plugins: what is configured vs what is actually live,
// plus the origin the artifact came from (null when created headless).
const workerStatus = async (store: Store, id: string) => {
  const meta = await readArtifactMeta(store, id)
  const settings = await readEffectiveSettings(store.home)
  const presence = workerRuntime.current?.presence(id)
  return {
    artifactId: id,
    attached: isAgentAttached(id),
    reviewer: {
      adapter: settings.reviewer.adapter,
      bound: presence?.reviewerBound ?? false,
    },
    worker: {
      adapter: settings.worker.adapter,
      running: presence?.workerRunning ?? false,
      bound: presence?.workerBound ?? false,
    },
    origin: meta.origin ?? null,
  }
}

// Dispatch the frozen batch to the worker lane: attach, seed the current
// document from disk, wait for the async bind, enqueue. False when the lane
// never bound or refused the duty (broken adapter, lost race).
const dispatchIteration = async (
  store: Store,
  id: string,
  meta: ArtifactMeta,
  version: ArtifactVersion,
  settings: Awaited<ReturnType<typeof readEffectiveSettings>>,
): Promise<boolean> => {
  const dispatcher = workerRuntime.current
  if (settings.worker.adapter === "none" || dispatcher === undefined) return true
  dispatcher.attachWorker(id)
  const batchThreadIds = version.batch?.threadIds ?? []
  const view = await readFeedbackView(store, id)
  const batchThreads = view.threads.filter((thread) => batchThreadIds.includes(thread.id))
  // Current version's document on disk: <home>/artifacts/<id>/<version>/index.html.
  const htmlPath = join(artifactVersionDir(store, id, meta.current), "index.html")
  const seed: SeedSpec = {
    html: await readFile(htmlPath, "utf8").catch(() => ""),
    version: meta.current,
  }
  const bound = await waitForLaneBind(id, "worker")
  const enqueued = dispatcher.enqueueWork(
    id,
    {
      lane: "worker",
      promptTemplate: settings.prompts.worker,
      brief: meta.prompt,
      title: meta.title,
      version: meta.current,
      threads: batchThreads,
      targets: [],
      batchThreadIds: batchThreadIds,
      htmlPath: htmlPath,
    },
    seed,
  )
  if (!bound || !enqueued) {
    // The status already flipped, so fail the lane (notifies origin) and let
    // the user re-Iterate or the fallback agent publish.
    await dispatcher.fail(id, "worker", "worker lane did not bind for this iteration")
    return false
  }
  return true
}

export type ApiRoutesOptions = {
  // Test seam: replaces the default adapter registry (the real ACP adapter).
  adapters?: DispatcherAdapters
}

export const registerApiRoutes = (app: FastifyInstance, store: Store, options?: ApiRoutesOptions): void => {
  // Server-owned agent lanes. The real adapters read lane config from live
  // settings at duty time; tests inject fakes through ServerOptions.
  workerRuntime.current = createDispatcher({
    home: store.home,
    adapters: options?.adapters ?? {
      acp: createAcpAdapter({
        getLaneConfig: async (lane) => (await readEffectiveSettings(store.home))[lane],
      }),
      "opencode-sdk": createOpenCodeSdkAdapter({
        getLaneConfig: async (lane) => (await readEffectiveSettings(store.home))[lane],
        getServerUrl: async () => (await readEffectiveSettings(store.home)).opencodeServerUrl,
      }),
    },
    handlers: {
      onReplies: (artifactId, result) => handleReplies(store, artifactId, result.items),
      onDocument: (artifactId, doc) => handleDocument(store, artifactId, doc),
      onError: (artifactId, lane, detail) => handleError(store, artifactId, lane, detail),
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
    // Attach the reviewer lane right away so comments from the first minute
    // get live replies. Bind lands async; the summary reports "starting".
    const settings = await readEffectiveSettings(store.home)
    if (settings.reviewer.adapter !== "none") workerRuntime.current?.attachReviewer(meta.id)
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

  // Lane debug view: configured vs live per lane, plus the artifact origin.
  app.get("/api/v1/artifacts/:id/worker", async (request) => {
    const { id } = IdParamsSchema.parse(request.params)
    return workerStatus(store, id)
  })

  // Submit the feedback batch: freeze open threads into a pending version
  // row and flip review -> iterating. The UI gates the button on presence,
  // but the API accepts detached iterations so they recover later. With a
  // worker adapter configured, the frozen batch is dispatched as a work duty.
  app.post("/api/v1/artifacts/:id/iterations", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params)
    if ((await countOpenThreads(store, id)) === 0) {
      throw storeError("unprocessable", "nothing to iterate: no open threads")
    }
    const settings = await readEffectiveSettings(store.home)
    // One work duty at a time per artifact: reject before startIteration so
    // a busy worker never leaves a stranded iterating artifact behind.
    if (workerRuntime.current?.presence(id).workerRunning === true) {
      throw storeError("conflict", "worker is busy")
    }
    const { meta, version } = await startIteration(store, id)
    if (!(await dispatchIteration(store, id, meta, version, settings))) {
      throw storeError("conflict", "worker lane failed to start")
    }
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
  // review and can always be iterated again. Ends the agent round: lanes
  // detach (in-flight duties still land) and the origin hears the verdict.
  app.post("/api/v1/artifacts/:id/versions/:version/approve", async (request) => {
    const { id, version } = ApproveParamsSchema.parse(request.params)
    const row = await approveVersion(store, id, version)
    workerRuntime.current?.unbindAll(id)
    void notifyOriginLine(store, id, () => version + " approved — done for now").catch(() => undefined)
    return row
  })

  app.get("/api/v1/artifacts/:id/feedback", async (request) => {
    const { id } = IdParamsSchema.parse(request.params)
    const query = FeedbackQuerySchema.parse(request.query)
    const waits = query.wait ?? 0
    if (waits <= 0) {
      const view = await readFeedbackView(store, id, query.version)
      return { ...view, agentAttached: isAgentAttached(id), ...lanePresence(id) }
    }
    const deadline = Date.now() + waits * 1000
    waitingAgents.set(id, (waitingAgents.get(id) ?? 0) + 1)
    try {
      for (;;) {
        // Artifact-scoped view: every thread, newest first. With ?version=vN,
        // only threads pinned on vN. The poll wakes when updatedAt (thread
        // activity, replies, approve) or iteratedAt (Iterate) moves past
        // `after` — no matter which version a thread lives in.
        const view = await readFeedbackView(store, id, query.version)
        const changed =
          query.after !== undefined && (view.updatedAt > query.after || view.iteratedAt > query.after)
        if (changed || Date.now() >= deadline) return { ...view, agentAttached: true, ...lanePresence(id) }
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
      body.author === "user" && (isAgentAttached(id) || (await reviewerConfigured(store)))
        ? await appendThreadMessage(store, id, thread.id, {
            body: "…",
            author: "agent",
            kind: "thinking",
          })
        : thread
    // Fire-and-forget: the route answers with the placeholder now; the
    // reviewer duty fills it from the lane.
    void dispatchReplies(store, id).catch(() => undefined)
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
      (isAgentAttached(id) || (await reviewerConfigured(store)))
    ) {
      thread = await appendThreadMessage(store, id, threadId, {
        body: "…",
        author: "agent",
        kind: "thinking",
      })
    }
    void dispatchReplies(store, id).catch(() => undefined)
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
