import { RedlineSettings } from "../store/settings.models"
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

export type DispatcherAdapters = Partial<Record<AdapterId, HostAdapter>>

export type DispatcherHandlers = {
  onReplies: (artifactId: string, items: DutyResult & { kind: "replies" }) => Promise<void> | void
  onDocument: (artifactId: string, doc: DutyResult & { kind: "document" }) => Promise<void> | void
  onError: (artifactId: string, lane: Lane, detail: string) => Promise<void> | void
}

export type DispatcherOptions = {
  // Settings are read through this home at call time, so config flips land
  // without a restart.
  home: string
  // Adapter registry. artifact.routes registers the real ACP adapter;
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
  // End-of-round detach, called on approve.
  unbindAll: (artifactId: string) => void
}

// Module-level default the routes module initializes at server build time,
// mirroring the in-memory waitingAgents map in artifact.routes.ts.
export const workerRuntime: { current: Dispatcher | undefined } = { current: undefined }

type ArtifactRuntime = {
  reviewerBound: boolean
  workerBound: boolean
  reviewerRunning: boolean
  workerRunning: boolean
  reviewerQueue: DutyInput[]
}

type CachedSession = { adapter: HostAdapter; session: AgentSession }

const errorDetail = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const canNotify = (adapter: HostAdapter): boolean =>
  adapter.canNotifyOrigin() && adapter.notifyOrigin !== undefined

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
  // the fresh document.
  const ensureSession = async (
    artifactId: string,
    lane: Lane,
    adapter: HostAdapter,
    seed?: SeedSpec,
  ): Promise<AgentSession> => {
    const cached = cachedSession(artifactId, lane)
    if (seed === undefined && cached !== undefined && cached.adapter === adapter) return cached.session
    const session = await adapter.ensureSession(lane, artifactId, seed)
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
    try {
      const adapter = await resolveAdapter("worker")
      if (adapter === undefined) {
        await fail(artifactId, "worker", "worker adapter is not configured")
        return
      }
      const session = await ensureSession(artifactId, "worker", adapter, seed)
      const result = await adapter.runDuty(session, input)
      if (result.kind !== "document") {
        await fail(artifactId, "worker", "work duty returned replies")
        return
      }
      await handlers.onDocument(artifactId, result)
    } catch (error) {
      await fail(artifactId, "worker", errorDetail(error))
    } finally {
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
