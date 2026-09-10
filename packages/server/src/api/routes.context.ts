import { readFile } from "node:fs/promises"

import { FastifyReply, FastifyRequest } from "fastify"

import { requestOrigin } from "../http/request.origin"
import {
  appendThreadMessage,
  artifactVersionFile,
  countOpenThreads,
  publishIteration,
  readArtifactMeta,
  readFeedbackView,
  replaceThinkingMessage,
  rollbackIteration,
  Store,
  touchIteration,
} from "../store/artifact.store"
import { ArtifactMeta, ArtifactVersion, isPendingVersion, Thread } from "@redline/http-contracts/artifact.models"
import { ArtifactSummary } from "@redline/http-contracts/artifact.schemas"
import { readEffectiveSettings } from "../store/settings.store"
import { createAcpAdapter } from "../worker/acp.adapter"
import {
  createDispatcher,
  DispatcherAdapters,
  workerRuntime,
} from "../worker/dispatcher"
import { DutyResult, Lane, SeedSpec, ThreadRef } from "../worker/host.adapter"
import { createOpenCodeSdkAdapter } from "../worker/opencode.sdk.adapter"
import { AcpProbe, probeAcpHandshake } from "../worker/probe"

export type RouteDescriptor = {
  method: "GET" | "POST" | "PATCH" | "PUT"
  url: string
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export type RoutesContext = {
  store: Store
  adapters: DispatcherAdapters | undefined
  // Test seam: overrides the ACP handshake probe in the settings routes.
  probeAcp: AcpProbe
  isAgentAttached: (id: string) => boolean
  lanePresence: (id: string) => { reviewerAttached: boolean; workerRunning: boolean }
  // True while an iteration duty is in flight with a fresh heartbeat. While
  // status=iterating and this is false, the round is orphaned or wedged and
  // the user should be offered Stop.
  workerLive: (id: string) => Promise<boolean>
  reviewerConfigured: () => Promise<boolean>
  artifactApiUrl: (origin: string, id: string) => string
  summarizeArtifact: (origin: string, meta: ArtifactMeta) => Promise<ArtifactSummary>
  dispatchReplies: (artifactId: string) => Promise<void>
  workerStatus: (id: string) => Promise<unknown>
  dispatchIteration: (
    id: string,
    meta: ArtifactMeta,
    version: ArtifactVersion,
    settings: Awaited<ReturnType<typeof readEffectiveSettings>>,
  ) => Promise<boolean>
  beginWaitingAgent: (id: string) => void
  endWaitingAgent: (id: string) => void
}

// Presence: how many feedback long-polls (?wait=) are in flight per artifact.
// In memory only. Gates the thinking placeholder and the shell's Iterate
// button — the two places that must be honest about the agent listening.
const waitingAgents = new Map<string, number>()

const reviewerConfigured = async (store: Store): Promise<boolean> =>
  (await readEffectiveSettings(store.home)).reviewer.adapter !== "none"

// A configured reviewer answers comments even before its bind lands (fresh
// daemon, settings flipped after create), so placeholder placement must not
// depend on live presence alone.
const isAgentAttached = (store: Store, id: string): boolean =>
  (waitingAgents.get(id) ?? 0) > 0 ||
  (workerRuntime.current?.presence(id).reviewerBound ?? false) ||
  (workerRuntime.current?.presence(id).workerRunning ?? false)

// Per-lane presence for the feedback view, so the shell can say which lane
// is actually live instead of collapsing everything into agentAttached.
const lanePresence = (id: string): { reviewerAttached: boolean; workerRunning: boolean } => {
  const presence = workerRuntime.current?.presence(id)
  return {
    reviewerAttached: presence?.reviewerBound === true,
    workerRunning: presence?.workerRunning === true,
  }
}

// A duty counts as live when it is in flight in this process and its
// heartbeat is fresh (or its first stamp has not landed yet — handshakes
// precede it). A stale heartbeat with a running duty reads as wedged.
const heartbeatStaleMs = 90_000

const workerLive = async (store: Store, id: string): Promise<boolean> => {
  if (workerRuntime.current?.presence(id).workerRunning !== true) return false
  const meta = await readArtifactMeta(store, id).catch(() => undefined)
  const heartbeatAt = meta?.versions.find(isPendingVersion)?.batch?.heartbeatAt
  if (heartbeatAt === undefined) return true
  return Date.now() - Date.parse(heartbeatAt) <= heartbeatStaleMs
}

const artifactApiUrl = (origin: string, id: string): string => origin + "/api/v1/artifacts/" + id

const assetsCount = (meta: ArtifactMeta): number =>
  meta.versions.reduce((total, row) => total + (row.assets?.length ?? 0), 0)

const summarizeArtifact = async (
  store: Store,
  origin: string,
  meta: ArtifactMeta,
): Promise<ArtifactSummary> => {
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
    assetsCount: assetsCount(meta),
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

// Worker progress notes: appended as agent messages on the batch threads
// that are still open. Per-thread failures are swallowed (the thread may
// vanish mid-duty), and resolved threads stay quiet. Also used by the stop
// route to mark an abandoned round.
export const postThreadNotes = async (
  store: Store,
  artifactId: string,
  threadIds: string[],
  body: string,
): Promise<void> => {
  const view = await readFeedbackView(store, artifactId).catch(() => undefined)
  if (view === undefined) return
  const open = new Set(view.threads.filter((thread) => thread.status === "open").map((thread) => thread.id))
  for (const threadId of threadIds) {
    if (!open.has(threadId)) continue
    await appendThreadMessage(store, artifactId, threadId, {
      body: body,
      author: "agent",
      kind: "text",
    }).catch(() => undefined)
  }
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
  for (const item of items) {
    await tryPatchTarget(store, artifactId, item, item.body)
  }
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
  const fresh = await readArtifactMeta(store, artifactId)
  const publishedRow = fresh.versions.find((row) => row.version === fresh.current)
  const note = doc.note ?? ""
  await postThreadNotes(
    store,
    artifactId,
    publishedRow?.batch?.threadIds ?? [],
    "Addressed in " + fresh.current + (note === "" ? "." : ". " + note),
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
  // Worker errors self-heal: roll the pending iteration back so the
  // artifact returns to review with every thread still open, ready for a
  // fresh Iterate. A duty that lands after this (slow host, race with
  // Stop) is dropped by handleDocument's status check.
  const meta = await readArtifactMeta(store, artifactId).catch(() => undefined)
  const pending = meta !== undefined && meta.status === "iterating" ? meta.versions.find(isPendingVersion) : undefined
  if (meta === undefined || pending === undefined) return
  await rollbackIteration(store, artifactId)
  await postThreadNotes(
    store,
    artifactId,
    pending.batch?.threadIds ?? [],
    "Iteration failed: " + detail + " — threads stay open; Iterate again when ready.",
  )
}

// Lane debug view for plugins: what is configured vs what is actually live,
// plus the origin the artifact came from (null when created headless).
const workerStatus = async (store: Store, id: string) => {
  const meta = await readArtifactMeta(store, id)
  const settings = await readEffectiveSettings(store.home)
  const presence = workerRuntime.current?.presence(id)
  return {
    artifactId: id,
    attached: isAgentAttached(store, id),
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
  // Current version's document on disk: <home>/artifacts/<id>/vN-index.html.
  const htmlPath = artifactVersionFile(store, id, meta.current)
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
      // Project directory captured at create time: the worker spawns there
      // and reads the originating repo (read-only).
      cwd: meta.origin?.cwd,
    },
    seed,
  )
  if (!bound || !enqueued) {
    // The status already flipped, so fail the lane (notifies origin) and let
    // the user re-Iterate or the fallback agent publish.
    await dispatcher.fail(id, "worker", "worker lane did not bind for this iteration")
    return false
  }
  // Mark the batch as picked up: one agent message per open thread, so the
  // review UI shows the worker claiming the batch while the duty runs.
  await postThreadNotes(store, id, batchThreadIds, "Working on this for " + version.version + ".")
  return true
}

export type RoutesSeams = {
  // Test seam: replaces the dispatcher's default adapter registry.
  adapters?: DispatcherAdapters
  // Test seam: overrides the ACP handshake probe in the settings routes.
  probeAcp?: AcpProbe
}

// Server-owned agent lanes. The real adapters read lane config from live
// settings at duty time; tests inject fakes through ServerOptions. Must be
// installed exactly once (artifact routes own it).
export const installDispatcher = (store: Store, seams?: RoutesSeams): void => {
  workerRuntime.current = createDispatcher({
    home: store.home,
    adapters: seams?.adapters ?? {
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
      onWorkerHeartbeat: (artifactId, session) => touchIteration(store, artifactId, session),
    },
  })
}

export const createRoutesContext = (store: Store, seams?: RoutesSeams): RoutesContext => {
  return {
    store,
    adapters: seams?.adapters,
    probeAcp: seams?.probeAcp ?? probeAcpHandshake,
    isAgentAttached: (id) => isAgentAttached(store, id),
    lanePresence,
    workerLive: (id) => workerLive(store, id),
    reviewerConfigured: () => reviewerConfigured(store),
    artifactApiUrl,
    summarizeArtifact: (origin, meta) => summarizeArtifact(store, origin, meta),
    dispatchReplies: (artifactId) => dispatchReplies(store, artifactId),
    workerStatus: (id) => workerStatus(store, id),
    dispatchIteration: (id, meta, version, settings) =>
      dispatchIteration(store, id, meta, version, settings),
    beginWaitingAgent: (id) => {
      waitingAgents.set(id, (waitingAgents.get(id) ?? 0) + 1)
    },
    endWaitingAgent: (id) => {
      waitingAgents.set(id, Math.max((waitingAgents.get(id) ?? 1) - 1, 0))
    },
  }
}

export const origin = (request: FastifyRequest): string => requestOrigin(request)
