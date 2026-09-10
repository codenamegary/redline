import { RedlineSettings } from "@redline/http-contracts/settings.models"
import { readEffectiveSettings } from "../store/settings.store"
import {
  AdapterId,
  AgentSession,
  DutyInput,
  DutyResult,
  HostAdapter,
  Lane,
  OriginRef,
  SeedSpec,
} from "./host.adapter"
import { errorDetail } from "./util"

export type DispatcherAdapters = Partial<Record<AdapterId, HostAdapter>>

export type DispatcherHandlers = {
  onReplies: (artifactId: string, items: DutyResult & { kind: "replies" }) => Promise<void> | void
  onDocument: (artifactId: string, doc: DutyResult & { kind: "document" }) => Promise<void> | void
  onError: (artifactId: string, lane: Lane, detail: string) => Promise<void> | void
  // Liveness stamp for the pending iteration while a work duty runs. Called
  // once with the host session when the duty starts, then on an interval.
  onWorkerHeartbeat?: (
    artifactId: string,
    session?: { adapterId: string; sessionId: string },
  ) => Promise<void> | void
}

export type DispatcherOptions = {
  // Settings are read through this home at call time, so config flips land
  // without a restart.
  home: string
  // Adapter registry. routes.context.ts registers the real ACP adapter;
  // tests register fakes. Lanes resolve the adapter again at duty time.
  adapters: DispatcherAdapters
  handlers: DispatcherHandlers
}

export type Dispatcher = {
  // Binding reads settings, so it lands a tick later; duties resolve the
  // adapter again at run time. A lane whose adapter is "none" or missing
  // from the registry never binds, and enqueue answers false.
  attachReviewer: (artifactId: string) => void
  attachWorker: (artifactId: string) => void
  presence: (artifactId: string) => {
    reviewerBound: boolean
    workerBound: boolean
    workerRunning: boolean
  }
  // Queues when a reply duty is already in flight; drains FIFO. False when
  // the reviewer lane is not bound.
  enqueueReply: (artifactId: string, input: DutyInput) => boolean
  // One work duty per artifact at a time. Iterate is user-gated and ever
  // has one pending batch, so a running worker rejects instead of queuing.
  enqueueWork: (artifactId: string, input: DutyInput, seed?: SeedSpec) => boolean
  notifyOrigin: (artifactId: string, origin: OriginRef | undefined, text: string) => Promise<void>
  // Internal error path: reports and resets the lane. A reviewer crash
  // unbinds; a worker crash returns the lane to idle.
  fail: (artifactId: string, lane: Lane, detail: string) => Promise<void>
  // Best-effort cancel of the running work duty (kills the ACP child,
  // deletes the opencode session). False when no duty is in flight.
  interruptWorker: (artifactId: string) => boolean
  // Read-only session log of the running (or most recent) work duty, via
  // the cached session. Empty when no session is cached.
  workerLog: (artifactId: string) => Promise<string>
  // End-of-round detach, called on approve.
  unbindAll: (artifactId: string) => void
}

// Module-level default the routes module initializes at server build time,
// mirroring the in-memory waitingAgents map in api/routes.context.ts.
export const workerRuntime: { current: Dispatcher | undefined } = { current: undefined }

type ArtifactRuntime = {
  reviewerBound: boolean
  workerBound: boolean
  reviewerRunning: boolean
  workerRunning: boolean
  reviewerQueue: DutyInput[]
}

type CachedSession = { adapter: HostAdapter; session: AgentSession }

const canNotify = (adapter: HostAdapter): boolean =>
  adapter.canNotifyOrigin() && adapter.notifyOrigin !== undefined

// How often a running work duty stamps the pending batch's heartbeat.
const heartbeatIntervalMs = 15_000

export const createDispatcher = (options: DispatcherOptions): Dispatcher => {
  const { home, adapters, handlers } = options

  const runtimes = new Map<string, ArtifactRuntime>()
  const sessions = new Map<string, { reviewer?: CachedSession; worker?: CachedSession }>()

  const runtimeFor = (artifactId: string): ArtifactRuntime => {
    let runtime = runtimes.get(artifactId)
    if (runtime === undefined) {
      runtime = {
        reviewerBound: false,
        workerBound: false,
        reviewerRunning: false,
        workerRunning: false,
        reviewerQueue: [],
      }
      runtimes.set(artifactId, runtime)
    }
    return runtime
  }

  // Adapter resolution is dynamic: "none" or an id absent from the registry
  // reads as no adapter.
  const adapterFor = (lane: Lane, settings: RedlineSettings): HostAdapter | undefined => {
    const config = lane === "reviewer" ? settings.reviewer : settings.worker
    if (config.adapter === "none") return undefined
    return adapters[config.adapter]
  }

  const resolveAdapter = async (lane: Lane): Promise<HostAdapter | undefined> =>
    adapterFor(lane, await readEffectiveSettings(home))

  const cachedSession = (artifactId: string, lane: Lane): CachedSession | undefined =>
    sessions.get(artifactId)?.[lane]

  const cacheSession = (artifactId: string, lane: Lane, cached: CachedSession): void => {
    const perArtifact = sessions.get(artifactId) ?? {}
    perArtifact[lane] = cached
    sessions.set(artifactId, perArtifact)
  }

  const discardSession = (artifactId: string, lane: Lane): void => {
    const cached = sessions.get(artifactId)?.[lane]
    const perArtifact = sessions.get(artifactId)
    if (cached === undefined || perArtifact === undefined) return
    delete perArtifact[lane]
    // Best-effort teardown: a failing discard must not break the unbind.
    void Promise.resolve(cached.adapter.discard?.(cached.session)).catch(() => undefined)
  }

  // A lane keeps one host session per artifact. Seedless duties (reviewer)
  // reuse it; seeded duties (worker) re-ensure so the adapter can pick up
  // the fresh document. Replacing a cached session (new Iterate, adapter
  // flipped) discards the old one first: a cached ACP session is a live
  // child process, and overwriting the slot would leak it.
  const ensureSession = async (
    artifactId: string,
    lane: Lane,
    adapter: HostAdapter,
    seed?: SeedSpec,
    cwd?: string,
  ): Promise<AgentSession> => {
    const cached = cachedSession(artifactId, lane)
    if (seed === undefined && cached !== undefined && cached.adapter === adapter) return cached.session
    if (cached !== undefined) discardSession(artifactId, lane)
    const session = await adapter.ensureSession(lane, artifactId, seed, cwd)
    cacheSession(artifactId, lane, { adapter, session })
    return session
  }

  const fail = async (artifactId: string, lane: Lane, detail: string): Promise<void> => {
    if (lane === "reviewer") {
      const runtime = runtimeFor(artifactId)
      runtime.reviewerBound = false
      runtime.reviewerQueue = []
    } else {
      runtimeFor(artifactId).workerRunning = false
    }
    discardSession(artifactId, lane)
    // An error handler failure must not surface as an unhandled rejection.
    try {
      await handlers.onError(artifactId, lane, detail)
    } catch {
      // Ignored on purpose.
    }
  }

  const runReplyDuty = async (artifactId: string, input: DutyInput): Promise<void> => {
    const runtime = runtimeFor(artifactId)
    runtime.reviewerRunning = true
    try {
      const adapter = await resolveAdapter("reviewer")
      if (adapter === undefined) {
        await fail(artifactId, "reviewer", "reviewer adapter is not configured")
        return
      }
      const session = await ensureSession(artifactId, "reviewer", adapter)
      const result = await adapter.runDuty(session, input)
      if (result.kind !== "replies") {
        await fail(artifactId, "reviewer", "reply duty returned a document")
        return
      }
      await handlers.onReplies(artifactId, result)
    } catch (error) {
      await fail(artifactId, "reviewer", errorDetail(error))
    } finally {
      runtime.reviewerRunning = false
      drainReviewer(artifactId)
    }
  }

  const drainReviewer = (artifactId: string): void => {
    const runtime = runtimeFor(artifactId)
    const next = runtime.reviewerQueue[0]
    if (next === undefined || runtime.reviewerRunning || !runtime.reviewerBound) return
    runtime.reviewerQueue = runtime.reviewerQueue.slice(1)
    void runReplyDuty(artifactId, next)
  }

  const runWorkDuty = async (artifactId: string, input: DutyInput, seed?: SeedSpec): Promise<void> => {
    const runtime = runtimeFor(artifactId)
    runtime.workerRunning = true
    let heartbeat: ReturnType<typeof setInterval> | undefined
    try {
      const adapter = await resolveAdapter("worker")
      if (adapter === undefined) {
        await fail(artifactId, "worker", "worker adapter is not configured")
        return
      }
      const session = await ensureSession(artifactId, "worker", adapter, seed, input.cwd)
      // Liveness: stamp the host session on the pending batch, then
      // heartbeat while the duty runs, so the UI can tell a live round from
      // an orphaned one.
      await handlers.onWorkerHeartbeat?.(artifactId, {
        adapterId: adapter.id,
        sessionId: session.hostSessionId,
      })
      heartbeat = setInterval(() => {
        void Promise.resolve(handlers.onWorkerHeartbeat?.(artifactId)).catch(() => undefined)
      }, heartbeatIntervalMs)
      heartbeat.unref?.()
      const result = await adapter.runDuty(session, input)
      if (result.kind !== "document") {
        await fail(artifactId, "worker", "work duty returned replies")
        return
      }
      await handlers.onDocument(artifactId, result)
      // Each Iterate is a fresh worker: once the document has landed the
      // host session is done, so tear it down instead of caching a live
      // child process until the next Iterate or approve.
      discardSession(artifactId, "worker")
    } catch (error) {
      await fail(artifactId, "worker", errorDetail(error))
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      runtime.workerRunning = false
    }
  }

  const attach = (artifactId: string, lane: Lane): void => {
    void (async () => {
      const adapter = await resolveAdapter(lane)
      if (adapter === undefined) return
      if (lane === "reviewer") runtimeFor(artifactId).reviewerBound = true
      else runtimeFor(artifactId).workerBound = true
    })().catch(() => undefined)
  }

  return {
    attachReviewer: (artifactId) => attach(artifactId, "reviewer"),
    attachWorker: (artifactId) => attach(artifactId, "worker"),

    presence: (artifactId) => {
      const runtime = runtimes.get(artifactId)
      return {
        reviewerBound: runtime?.reviewerBound ?? false,
        workerBound: runtime?.workerBound ?? false,
        workerRunning: runtime?.workerRunning ?? false,
      }
    },

    enqueueReply: (artifactId, input) => {
      const runtime = runtimeFor(artifactId)
      if (!runtime.reviewerBound) return false
      if (runtime.reviewerRunning) {
        runtime.reviewerQueue.push(input)
        return true
      }
      void runReplyDuty(artifactId, input)
      return true
    },

    enqueueWork: (artifactId, input, seed) => {
      const runtime = runtimeFor(artifactId)
      if (!runtime.workerBound || runtime.workerRunning) return false
      void runWorkDuty(artifactId, input, seed)
      return true
    },

    notifyOrigin: async (artifactId, origin, text) => {
      if (origin === undefined) return
      // prompt_async is OpenCode-only: a pi origin session id would be
      // POSTed to an OpenCode server, so other hosts never notify.
      if (origin.host !== "opencode") return
      const settings = await readEffectiveSettings(home)
      if (!settings.notifyOrigin) return
      const workerAdapter = adapterFor("worker", settings)
      const reviewerAdapter = adapterFor("reviewer", settings)
      const chosen =
        workerAdapter !== undefined && canNotify(workerAdapter)
          ? workerAdapter
          : reviewerAdapter !== undefined && canNotify(reviewerAdapter)
            ? reviewerAdapter
            : undefined
      await chosen?.notifyOrigin?.(origin, text)
    },

    fail,

    interruptWorker: (artifactId) => {
      const runtime = runtimes.get(artifactId)
      const cached = sessions.get(artifactId)?.worker
      if (runtime?.workerRunning !== true || cached === undefined) return false
      // The adapter kills the session; runDuty settles with an error and
      // the normal fail path reports it.
      void Promise.resolve(cached.adapter.interrupt?.(cached.session)).catch(() => undefined)
      return true
    },

    workerLog: async (artifactId) => {
      const cached = sessions.get(artifactId)?.worker
      if (cached === undefined) return ""
      try {
        return (await cached.adapter.sessionLog?.(cached.session)) ?? ""
      } catch {
        return ""
      }
    },

    unbindAll: (artifactId) => {
      const runtime = runtimes.get(artifactId)
      if (runtime === undefined) return
      runtime.reviewerBound = false
      runtime.workerBound = false
      runtime.reviewerQueue = []
      discardSession(artifactId, "reviewer")
      discardSession(artifactId, "worker")
    },
  }
}
