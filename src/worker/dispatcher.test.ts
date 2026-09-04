import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { defaultSettings, saveSettings } from "../store/settings.store"
import { RedlineSettings } from "../store/settings.models"
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
import { createDispatcher, DispatcherAdapters, DispatcherHandlers } from "./dispatcher"

const homes: string[] = []

afterAll(async () => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (probe: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (probe()) return
    await sleep(5)
  }
  throw new Error("condition not met within timeout")
}

const makeHome = async (adjust?: (settings: RedlineSettings) => RedlineSettings): Promise<string> => {
  const home = mkdtempSync(join(tmpdir(), "redline-dispatcher-"))
  homes.push(home)
  const settings = adjust === undefined ? defaultSettings() : adjust(defaultSettings())
  await saveSettings(home, settings)
  return home
}

type DispatcherEvent =
  | { kind: "replies"; artifactId: string; result: DutyResult & { kind: "replies" } }
  | { kind: "document"; artifactId: string; result: DutyResult & { kind: "document" } }
  | { kind: "error"; artifactId: string; lane: Lane; detail: string }

const makeDispatcher = (home: string, adapters: DispatcherAdapters) => {
  const events: DispatcherEvent[] = []
  const handlers: DispatcherHandlers = {
    onReplies: (artifactId, result) => {
      events.push({ kind: "replies", artifactId, result })
    },
    onDocument: (artifactId, result) => {
      events.push({ kind: "document", artifactId, result })
    },
    onError: (artifactId, lane, detail) => {
      events.push({ kind: "error", artifactId, lane, detail })
    },
  }
  return { events, dispatcher: createDispatcher({ home, adapters, handlers }) }
}

// Fake adapter with manual counters and a deferred gate the test controls.
type FakeAdapter = {
  adapter: HostAdapter
  ensureCalls: { lane: Lane; artifactId: string; seed?: SeedSpec }[]
  dutyCalls: { session: AgentSession; input: DutyInput }[]
  discards: AgentSession[]
  notifyCalls: { origin: OriginRef; text: string }[]
  results: DutyResult[]
  failures: string[]
  hold: () => void
  release: () => void
}

const fakeAdapter = (id: AdapterId, withNotifyOrigin = true): FakeAdapter => {
  const ensureCalls: { lane: Lane; artifactId: string; seed?: SeedSpec }[] = []
  const dutyCalls: { session: AgentSession; input: DutyInput }[] = []
  const discards: AgentSession[] = []
  const notifyCalls: { origin: OriginRef; text: string }[] = []
  const results: DutyResult[] = []
  const failures: string[] = []
  let held = false
  let gate: (() => void) | undefined

  const adapter: HostAdapter = {
    id,
    canNotifyOrigin: () => true,
    ensureSession: async (lane, artifactId, seed) => {
      ensureCalls.push({ lane, artifactId, seed })
      return {
        artifactId,
        lane,
        hostSessionId: id + "-" + artifactId + "-" + String(ensureCalls.length),
      }
    },
    runDuty: async (session, input) => {
      dutyCalls.push({ session, input })
      const failure = failures.shift()
      if (failure !== undefined) throw new Error(failure)
      if (held) await new Promise<void>((resolve) => (gate = resolve))
      const result = results.shift()
      if (result !== undefined) return result
      return { kind: "replies", items: [] }
    },
    discard: async (session) => {
      discards.push(session)
    },
  }
  if (withNotifyOrigin) {
    adapter.notifyOrigin = async (origin, text) => {
      notifyCalls.push({ origin, text })
    }
  }
  return {
    adapter,
    ensureCalls,
    dutyCalls,
    discards,
    notifyCalls,
    results,
    failures,
    hold: () => {
      held = true
    },
    release: () => {
      held = false
      gate?.()
      gate = undefined
    },
  }
}

const dutyInput = (overrides?: Partial<DutyInput>): DutyInput => ({
  lane: "reviewer",
  promptTemplate: "{{threads}}",
  brief: "landing page for a coffee brand",
  title: "Landing page",
  version: "v1",
  threads: [],
  targets: [{ threadId: "t1", messageId: "m1" }],
  ...overrides,
})

const replyResult = (body: string): DutyResult & { kind: "replies" } => ({
  kind: "replies",
  items: [{ threadId: "t1", messageId: "m1", body }],
})

describe("dispatcher", () => {
  it("runs a reply duty: ensureSession once, then runDuty, then onReplies", async () => {
    const home = await makeHome()
    const fake = fakeAdapter("acp")
    const { events, dispatcher } = makeDispatcher(home, { acp: fake.adapter })
    dispatcher.attachReviewer("a1")
    await waitFor(() => dispatcher.presence("a1").reviewerBound)

    fake.results.push(replyResult("on it"))
    expect(dispatcher.enqueueReply("a1", dutyInput())).toBe(true)
    await waitFor(() => events.length > 0)

    expect(fake.ensureCalls).toEqual([{ lane: "reviewer", artifactId: "a1", seed: undefined }])
    expect(fake.dutyCalls).toHaveLength(1)
    expect(events).toEqual([
      { kind: "replies", artifactId: "a1", result: replyResult("on it") },
    ])
  })

  it("queues replies while one is in flight and drains them FIFO", async () => {
    const home = await makeHome()
    const fake = fakeAdapter("acp")
    const { events, dispatcher } = makeDispatcher(home, { acp: fake.adapter })
    dispatcher.attachReviewer("a1")
    await waitFor(() => dispatcher.presence("a1").reviewerBound)

    fake.hold()
    fake.results.push(replyResult("first"), replyResult("second"), replyResult("third"))
    expect(dispatcher.enqueueReply("a1", dutyInput())).toBe(true)
    await waitFor(() => fake.dutyCalls.length === 1)
    expect(dispatcher.enqueueReply("a1", dutyInput())).toBe(true)
    expect(dispatcher.enqueueReply("a1", dutyInput())).toBe(true)
    expect(fake.dutyCalls).toHaveLength(1)

    fake.release()
    await waitFor(() => events.length === 3)
    expect(fake.ensureCalls).toHaveLength(1)
    expect(fake.dutyCalls).toHaveLength(3)
    const bodies = events.map((event) =>
      event.kind === "replies" ? (event.result.items[0]?.body ?? "") : "",
    )
    expect(bodies).toEqual(["first", "second", "third"])
  })

  it("runs a work duty immediately and passes the seed to ensureSession", async () => {
    const home = await makeHome()
    const fake = fakeAdapter("acp")
    const { events, dispatcher } = makeDispatcher(home, { acp: fake.adapter })
    dispatcher.attachWorker("a1")
    await waitFor(() => dispatcher.presence("a1").workerBound)

    const seed: SeedSpec = { html: "<p>v1</p>", version: "v1" }
    fake.hold()
    expect(
      dispatcher.enqueueWork("a1", dutyInput({ lane: "worker", batchThreadIds: ["t1"] }), seed),
    ).toBe(true)
    await waitFor(() => fake.dutyCalls.length === 1)
    // Worker duties do not queue: one at a time per artifact.
    expect(dispatcher.enqueueWork("a1", dutyInput({ lane: "worker" }))).toBe(false)

    fake.results.push({ kind: "document", html: "<p>v2</p>", note: "footer added" })
    fake.release()
    await waitFor(() => events.length === 1)
    expect(fake.ensureCalls).toEqual([{ lane: "worker", artifactId: "a1", seed }])
    expect(events).toEqual([
      {
        kind: "document",
        artifactId: "a1",
        result: { kind: "document", html: "<p>v2</p>", note: "footer added" },
      },
    ])
  })

  it("treats adapter none as unconfigured: enqueue false, handlers silent", async () => {
    const home = await makeHome((settings) => ({
      ...settings,
      reviewer: { ...settings.reviewer, adapter: "none" },
      worker: { ...settings.worker, adapter: "none" },
    }))
    const fake = fakeAdapter("acp")
    const { events, dispatcher } = makeDispatcher(home, { acp: fake.adapter })
    dispatcher.attachReviewer("a1")
    dispatcher.attachWorker("a1")
    await sleep(50)

    expect(dispatcher.enqueueReply("a1", dutyInput())).toBe(false)
    expect(dispatcher.enqueueWork("a1", dutyInput({ lane: "worker" }))).toBe(false)
    expect(dispatcher.presence("a1")).toEqual({
      reviewerBound: false,
      workerBound: false,
      workerRunning: false,
    })
    expect(events).toEqual([])
    expect(fake.dutyCalls).toEqual([])
  })

  it("treats an adapter id missing from the registry as unconfigured", async () => {
    const home = await makeHome()
    const { events, dispatcher } = makeDispatcher(home, {})
    dispatcher.attachReviewer("a1")
    dispatcher.attachWorker("a1")
    await sleep(50)

    expect(dispatcher.enqueueReply("a1", dutyInput())).toBe(false)
    expect(dispatcher.enqueueWork("a1", dutyInput({ lane: "worker" }))).toBe(false)
    expect(dispatcher.presence("a1")).toEqual({
      reviewerBound: false,
      workerBound: false,
      workerRunning: false,
    })
    expect(events).toEqual([])
  })

  it("reports a crashed duty, unbinds the reviewer, and idles the worker", async () => {
    const home = await makeHome()
    const fake = fakeAdapter("acp")
    const { events, dispatcher } = makeDispatcher(home, { acp: fake.adapter })
    dispatcher.attachReviewer("a1")
    await waitFor(() => dispatcher.presence("a1").reviewerBound)

    fake.failures.push("adapter exploded")
    expect(dispatcher.enqueueReply("a1", dutyInput())).toBe(true)
    await waitFor(() => events.length > 0)
    expect(events).toEqual([
      { kind: "error", artifactId: "a1", lane: "reviewer", detail: "adapter exploded" },
    ])
    // Crash unbinds: presence drops and the next enqueue is refused.
    expect(dispatcher.presence("a1").reviewerBound).toBe(false)
    expect(dispatcher.enqueueReply("a1", dutyInput())).toBe(false)

    // A worker crash returns the lane to idle instead of unbinding.
    dispatcher.attachWorker("a1")
    await waitFor(() => dispatcher.presence("a1").workerBound)
    fake.failures.push("worker exploded")
    expect(dispatcher.enqueueWork("a1", dutyInput({ lane: "worker" }))).toBe(true)
    await waitFor(() => events.length === 2)
    expect(events[1]).toEqual({
      kind: "error",
      artifactId: "a1",
      lane: "worker",
      detail: "worker exploded",
    })
    expect(dispatcher.presence("a1").workerRunning).toBe(false)
    expect(dispatcher.presence("a1").workerBound).toBe(true)
  })

  it("tracks presence across attach, duty, and unbind", async () => {
    const home = await makeHome()
    const fake = fakeAdapter("acp")
    const { events, dispatcher } = makeDispatcher(home, { acp: fake.adapter })
    expect(dispatcher.presence("a1")).toEqual({
      reviewerBound: false,
      workerBound: false,
      workerRunning: false,
    })

    dispatcher.attachReviewer("a1")
    dispatcher.attachWorker("a1")
    await waitFor(() => dispatcher.presence("a1").reviewerBound)
    await waitFor(() => dispatcher.presence("a1").workerBound)

    fake.hold()
    fake.results.push({ kind: "document", html: "<p>v2</p>", note: "footer" })
    const seed: SeedSpec = { html: "<p>v1</p>", version: "v1" }
    expect(dispatcher.enqueueWork("a1", dutyInput({ lane: "worker" }), seed)).toBe(true)
    await waitFor(() => fake.dutyCalls.length === 1)
    expect(dispatcher.presence("a1")).toEqual({
      reviewerBound: true,
      workerBound: true,
      workerRunning: true,
    })

    fake.release()
    await waitFor(() => events.length === 1)
    expect(dispatcher.presence("a1")).toEqual({
      reviewerBound: true,
      workerBound: true,
      workerRunning: false,
    })

    dispatcher.unbindAll("a1")
    expect(dispatcher.presence("a1")).toEqual({
      reviewerBound: false,
      workerBound: false,
      workerRunning: false,
    })
    expect(dispatcher.enqueueReply("a1", dutyInput())).toBe(false)
    // End-of-round detach discards whatever is still cached: the worker's
    // session was already discarded when its document landed, and no
    // reviewer duty ever cached one, so only the post-duty discard fired.
    expect(fake.discards).toHaveLength(1)
  })

  it("discards the worker session once the document lands (fresh worker per Iterate)", async () => {
    const home = await makeHome()
    const fake = fakeAdapter("acp")
    const { events, dispatcher } = makeDispatcher(home, { acp: fake.adapter })
    dispatcher.attachWorker("a1")
    await waitFor(() => dispatcher.presence("a1").workerBound)

    fake.results.push({ kind: "document", html: "<p>v2</p>", note: "footer" })
    expect(dispatcher.enqueueWork("a1", dutyInput({ lane: "worker" }), { html: "<p>v1</p>", version: "v1" })).toBe(true)
    await waitFor(() => events.length === 1)
    // The session the duty flew on is discarded after onDocument delivers.
    await waitFor(() => fake.discards.length === 1)
    expect(fake.discards[0]?.hostSessionId).toBe(fake.dutyCalls[0]?.session.hostSessionId)

    // A second Iterate gets a fresh session; the previous one was already
    // discarded, so exactly one live session existed at any time.
    fake.results.push({ kind: "document", html: "<p>v3</p>", note: "nav" })
    expect(dispatcher.enqueueWork("a1", dutyInput({ lane: "worker" }), { html: "<p>v2</p>", version: "v2" })).toBe(true)
    await waitFor(() => events.length === 2)
    await waitFor(() => fake.discards.length === 2)
    expect(fake.ensureCalls).toHaveLength(2)
    expect(fake.discards[1]?.hostSessionId).toBe(fake.dutyCalls[1]?.session.hostSessionId)
  })

  it("discards a cached session when the lane re-ensures with a different adapter", async () => {
    const home = await makeHome()
    const first = fakeAdapter("acp")
    const second = fakeAdapter("acp")
    const adapters: DispatcherAdapters = { acp: first.adapter }
    const { dispatcher } = makeDispatcher(home, adapters)
    dispatcher.attachReviewer("a1")
    await waitFor(() => dispatcher.presence("a1").reviewerBound)

    first.results.push(replyResult("on it"))
    expect(dispatcher.enqueueReply("a1", dutyInput())).toBe(true)
    await waitFor(() => first.dutyCalls.length === 1)
    expect(first.discards).toHaveLength(0)

    // Swap the registry entry: the cached session belongs to the old adapter
    // instance, so the next duty re-ensures and must discard the old one
    // instead of silently overwriting it.
    adapters.acp = second.adapter
    second.results.push(replyResult("again"))
    expect(dispatcher.enqueueReply("a1", dutyInput())).toBe(true)
    await waitFor(() => second.dutyCalls.length === 1)
    await waitFor(() => first.discards.length === 1)
    expect(first.discards[0]?.hostSessionId).toBe(first.dutyCalls[0]?.session.hostSessionId)
    expect(second.discards).toHaveLength(0)
  })

  it("notifyOrigin: skips non-opencode hosts, no-ops without origin or setting, prefers the worker adapter", async () => {
    const home = await makeHome((settings) => ({
      ...settings,
      reviewer: { ...settings.reviewer, adapter: "opencode-sdk" },
      worker: { ...settings.worker, adapter: "acp" },
    }))
    const workerFake = fakeAdapter("acp")
    const reviewerFake = fakeAdapter("opencode-sdk", false)
    const { dispatcher } = makeDispatcher(home, {
      acp: workerFake.adapter,
      "opencode-sdk": reviewerFake.adapter,
    })
    // prompt_async is OpenCode-only: a pi origin never notifies.
    await dispatcher.notifyOrigin("a1", { host: "pi", sessionId: "s1" }, "iteration published")
    expect(workerFake.notifyCalls).toEqual([])

    const origin: OriginRef = { host: "opencode", sessionId: "s1" }
    await dispatcher.notifyOrigin("a1", origin, "iteration published")
    expect(workerFake.notifyCalls).toEqual([{ origin, text: "iteration published" }])

    // An undefined origin is a no-op.
    await dispatcher.notifyOrigin("a1", undefined, "hello")
    expect(workerFake.notifyCalls).toHaveLength(1)

    // notifyOrigin disabled in settings is a no-op.
    const quietHome = await makeHome((settings) => ({
      ...settings,
      notifyOrigin: false,
      reviewer: { ...settings.reviewer, adapter: "opencode-sdk" },
      worker: { ...settings.worker, adapter: "acp" },
    }))
    const quietWorkerFake = fakeAdapter("acp")
    const quietDispatcher = makeDispatcher(quietHome, { acp: quietWorkerFake.adapter }).dispatcher
    await quietDispatcher.notifyOrigin("a1", origin, "hello")
    expect(quietWorkerFake.notifyCalls).toEqual([])

    // With the worker lane unconfigured, the reviewer adapter answers.
    const reviewerOnlyHome = await makeHome((settings) => ({
      ...settings,
      worker: { ...settings.worker, adapter: "none" },
      reviewer: { ...settings.reviewer, adapter: "opencode-sdk" },
    }))
    const reviewerOnlyFake = fakeAdapter("opencode-sdk")
    const reviewerOnlyDispatcher = makeDispatcher(reviewerOnlyHome, {
      "opencode-sdk": reviewerOnlyFake.adapter,
    }).dispatcher
    await reviewerOnlyDispatcher.notifyOrigin("a1", origin, "hello")
    expect(reviewerOnlyFake.notifyCalls).toEqual([{ origin, text: "hello" }])
  })
})
