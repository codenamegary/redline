import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  approveVersion,
  appendThread,
  appendThreadMessage,
  countOpenThreads,
  createArtifact,
  listArtifacts,
  openStore,
  publishIteration,
  readArtifactMeta,
  readFeedbackDoc,
  readFeedbackView,
  replaceThinkingMessage,
  setThreadStatus,
  startIteration,
  Store,
} from "./artifact.store"
import { isStoreError } from "./errors"

const homes: string[] = []

const makeStore = (): Store => {
  const home = mkdtempSync(join(tmpdir(), "redline-store-"))
  homes.push(home)
  return openStore(home)
}

describe("artifact store", () => {
  it("creates an artifact with a published v1 and review status", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, {
      title: "Dashboard redesign",
      prompt: "a metrics dashboard",
      html: "<h1 id=\"hero\">Hello</h1>",
    })
    expect(meta.status).toBe("review")
    expect(meta.current).toBe("v1")
    expect(meta.versions).toHaveLength(1)
    expect(meta.versions[0]?.publishedAt).toBeDefined()
    expect(meta.versions[0]?.batch).toBeUndefined()
    expect(meta.title).toBe("Dashboard redesign")
    expect(meta.prompt).toBe("a metrics dashboard")
    const html = readFileSync(join(store.artifactsDir, meta.id, "v1", "index.html"), "utf8")
    expect(html).toBe("<h1 id=\"hero\">Hello</h1>")
    const stored = JSON.parse(readFileSync(join(store.artifactsDir, meta.id, "meta.json"), "utf8")) as {
      id: string
    }
    expect(stored.id).toBe(meta.id)
  })

  it("builds unique slug ids for same-titled artifacts", async () => {
    const store = makeStore()
    const input = { title: "My Mock: v2!", prompt: "", html: "<p>x</p>" }
    const first = await createArtifact(store, input)
    const second = await createArtifact(store, input)
    expect(first.id).not.toBe(second.id)
    expect(first.id).toMatch(/-my-mock-v2$/)
    expect(second.id).toMatch(/-my-mock-v2-2$/)
  })

  it("runs the iteration loop: freeze batch, publish, back to review", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Deck", prompt: "", html: "<p>v1</p>" })
    const thread = await appendThread(store, meta.id, {
      version: "v1",
      anchor: null,
      body: "make it pop",
      author: "user",
    })
    const { meta: iterating, version } = await startIteration(store, meta.id)
    expect(iterating.status).toBe("iterating")
    expect(iterating.iteratedAt).toBeDefined()
    expect(version.version).toBe("v2")
    expect(version.publishedAt).toBeUndefined()
    expect(version.batch?.threadIds).toEqual([thread.id])
    expect(iterating.current).toBe("v1")

    const doubleIterate = startIteration(store, meta.id)
    expect(doubleIterate).rejects.toMatchObject({ kind: "conflict" })

    const published = await publishIteration(store, meta.id, { html: "<p>v2</p>", note: "second pass" })
    expect(published.status).toBe("review")
    expect(published.current).toBe("v2")
    expect(published.versions).toHaveLength(2)
    expect(published.versions[1]?.note).toBe("second pass")
    expect(published.versions[1]?.publishedAt).toBeDefined()
    expect(published.versions[1]?.batch?.threadIds).toEqual([thread.id])
    expect(readFileSync(join(store.artifactsDir, meta.id, "v1", "index.html"), "utf8")).toBe("<p>v1</p>")
    expect(readFileSync(join(store.artifactsDir, meta.id, "v2", "index.html"), "utf8")).toBe("<p>v2</p>")
  })

  it("rejects publishing outside iterating", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Page", prompt: "", html: "<p>v1</p>" })
    const early = publishIteration(store, meta.id, { html: "<p>v2</p>" })
    expect(early).rejects.toMatchObject({ kind: "conflict" })
  })

  it("stamps approval on the current version only, and never during iterating", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Page", prompt: "", html: "<p>v1</p>" })
    await startIteration(store, meta.id)
    const duringIterating = approveVersion(store, meta.id, "v1")
    expect(duringIterating).rejects.toMatchObject({ kind: "conflict" })
    const published = await publishIteration(store, meta.id, { html: "<p>v2</p>" })

    const approved = await approveVersion(store, meta.id, "v2")
    expect(approved.approvedAt).toBeDefined()
    expect((await readArtifactMeta(store, meta.id)).status).toBe("review")

    const again = await approveVersion(store, meta.id, "v2")
    expect(again.approvedAt).toBe(approved.approvedAt)

    const oldVersion = approveVersion(store, meta.id, "v1")
    expect(oldVersion).rejects.toMatchObject({ kind: "not-found" })
    expect(published.current).toBe("v2")
  })

  it("starts with empty feedback and accumulates threads", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Page", prompt: "", html: "<p>x</p>" })
    const empty = await readFeedbackDoc(store, meta.id, "v1")
    expect(empty.threads).toHaveLength(0)
    const thread = await appendThread(store, meta.id, {
      version: "v1",
      anchor: { selector: "#hero", text: "Hello", rect: { x: 1, y: 2, width: 3, height: 4 } },
      body: "make it pop",
      author: "user",
    })
    expect(thread.status).toBe("open")
    expect(thread.messages[0]?.body).toBe("make it pop")
    const doc = await readFeedbackDoc(store, meta.id, "v1")
    expect(doc.threads).toHaveLength(1)
    expect(doc.updatedAt).not.toBe("1970-01-01T00:00:00.000Z")
  })

  it("appends text messages and toggles thread status", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Page", prompt: "", html: "<p>x</p>" })
    const thread = await appendThread(store, meta.id, {
      version: "v1",
      anchor: null,
      body: "thoughts",
      author: "user",
    })
    expect(thread.messages[0]?.kind).toBe("text")
    const replied = await appendThreadMessage(store, meta.id, thread.id, {
      body: "good catch",
      author: "agent",
    })
    expect(replied.messages).toHaveLength(2)
    expect(replied.messages[1]?.author).toBe("agent")
    expect(replied.messages[1]?.kind).toBe("text")
    const resolved = await setThreadStatus(store, meta.id, thread.id, "resolved")
    expect(resolved.status).toBe("resolved")
    const reopened = await setThreadStatus(store, meta.id, thread.id, "open")
    expect(reopened.status).toBe("open")
  })

  it("replaces thinking placeholders and nothing else", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Page", prompt: "", html: "<p>x</p>" })
    const thread = await appendThread(store, meta.id, {
      version: "v1",
      anchor: null,
      body: "does this scale",
      author: "user",
    })
    const placeholder = await appendThreadMessage(store, meta.id, thread.id, {
      body: "…",
      author: "agent",
      kind: "thinking",
    })
    const placeholderId = placeholder.messages[1]?.id
    expect(placeholder.messages[1]?.kind).toBe("thinking")

    const answered = await replaceThinkingMessage(store, meta.id, thread.id, placeholderId ?? "", "yes, to 10k rows")
    expect(answered.messages[1]?.kind).toBe("text")
    expect(answered.messages[1]?.body).toBe("yes, to 10k rows")

    const twice = replaceThinkingMessage(store, meta.id, thread.id, placeholderId ?? "", "again")
    expect(twice).rejects.toMatchObject({ kind: "not-found" })
    const userMessage = replaceThinkingMessage(store, meta.id, thread.id, thread.messages[0]?.id ?? "", "nope")
    expect(userMessage).rejects.toMatchObject({ kind: "not-found" })
  })

  it("throws not-found store errors for unknown artifacts and threads", async () => {
    const store = makeStore()
    const missingArtifact = readArtifactMeta(store, "2099-01-01-000000-nope")
    expect(missingArtifact).rejects.toMatchObject({ kind: "not-found" })
    const meta = await createArtifact(store, { title: "Page", prompt: "", html: "<p>x</p>" })
    const missingThread = appendThreadMessage(store, meta.id, "t-missing", {
      body: "hi",
      author: "user",
    })
    expect(missingThread).rejects.toMatchObject({ kind: "not-found" })
    try {
      await readArtifactMeta(store, "2099-01-01-000000-nope")
      throw new Error("expected readArtifactMeta to throw")
    } catch (error) {
      expect(isStoreError(error)).toBe(true)
    }
  })

  it("lists artifacts newest first and skips junk directories", async () => {
    const store = makeStore()
    const first = await createArtifact(store, { title: "First", prompt: "", html: "<p>1</p>" })
    const second = await createArtifact(store, { title: "Second", prompt: "", html: "<p>2</p>" })
    const junkDir = join(store.artifactsDir, "junk-partial-write")
    mkdirSync(junkDir, { recursive: true })
    writeFileSync(join(junkDir, "orphan.txt"), "not a meta file")
    const metas = await listArtifacts(store)
    expect(metas.map((meta) => meta.id)).toEqual([second.id, first.id])
  })

  it("counts open threads across versions", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Page", prompt: "", html: "<p>1</p>" })
    const openThread = await appendThread(store, meta.id, {
      version: "v1",
      anchor: null,
      body: "open on v1",
      author: "user",
    })
    await startIteration(store, meta.id)
    await publishIteration(store, meta.id, { html: "<p>2</p>" })
    await appendThread(store, meta.id, {
      version: "v2",
      anchor: null,
      body: "open on v2",
      author: "user",
    })
    await setThreadStatus(store, meta.id, openThread.id, "resolved")
    expect(await countOpenThreads(store, meta.id)).toBe(1)
  })

  it("keeps threads visible across versions in the artifact-scoped view", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Page", prompt: "", html: "<p>1</p>" })
    const thread = await appendThread(store, meta.id, {
      version: "v1",
      anchor: { selector: "#hero", text: "one", rect: { x: 0, y: 0, width: 1, height: 1 } },
      body: "pinned on v1",
      author: "user",
    })
    expect(thread.anchorVersion).toBe("v1")
    await startIteration(store, meta.id)
    await publishIteration(store, meta.id, { html: "<p>2</p>" })

    const view = await readFeedbackView(store, meta.id)
    expect(view.version).toBe("v2")
    expect(view.current).toBe("v2")
    expect(view.versions).toHaveLength(2)
    expect(view.iteratedAt).not.toBe("1970-01-01T00:00:00.000Z")
    expect(view.threads).toHaveLength(1)
    expect(view.threads[0]?.anchorVersion).toBe("v1")

    const resolved = await setThreadStatus(store, meta.id, thread.id, "resolved")
    expect(resolved.resolvedInVersion).toBe("v2")
    const afterResolve = await readFeedbackView(store, meta.id)
    expect(afterResolve.threads).toHaveLength(1)
    expect(afterResolve.threads[0]?.resolvedInVersion).toBe("v2")

    const reopened = await setThreadStatus(store, meta.id, thread.id, "open")
    expect(reopened.resolvedInVersion).toBeUndefined()

    const v1Only = await readFeedbackView(store, meta.id, "v1")
    expect(v1Only.version).toBe("v1")
    expect(v1Only.threads).toHaveLength(1)
    const v2Only = await readFeedbackView(store, meta.id, "v2")
    expect(v2Only.threads).toHaveLength(0)
    const missing = readFeedbackView(store, meta.id, "v9")
    expect(missing).rejects.toMatchObject({ kind: "not-found" })
  })

  it("sorts the view newest-first and derives anchor versions for unpinned threads", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Page", prompt: "", html: "<p>1</p>" })
    const first = await appendThread(store, meta.id, {
      version: "v1",
      anchor: null,
      body: "resolved one",
      author: "user",
    })
    // ISO timestamps have millisecond precision; back-to-back appends can
    // land in the same ms and make the newest-first sort ambiguous. Pause so
    // createdAt ordering is deterministic.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = await appendThread(store, meta.id, {
      version: "v1",
      anchor: null,
      body: "open one",
      author: "user",
    })
    // Resolve the NEWER thread: newest-first means it still leads, even
    // though the older open thread would have won under open-first grouping.
    await setThreadStatus(store, meta.id, second.id, "resolved")

    // Rewrite the first thread without anchorVersion; the view derives it
    // from the feedback file name.
    const path = join(store.artifactsDir, meta.id, "feedback", "v1.json")
    const raw = JSON.parse(readFileSync(path, "utf8")) as { threads: Array<{ anchorVersion?: string }> }
    delete raw.threads[0]?.anchorVersion
    writeFileSync(path, JSON.stringify(raw), "utf8")

    const view = await readFeedbackView(store, meta.id)
    expect(view.threads[0]?.id).toBe(second.id)
    expect(view.threads[1]?.id).toBe(first.id)
    expect(view.threads[1]?.anchorVersion).toBe("v1")
  })
  it("rejects threads pinned on unknown versions", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Page", prompt: "", html: "<p>1</p>" })
    const bad = appendThread(store, meta.id, {
      version: "v9",
      anchor: null,
      body: "nowhere",
      author: "user",
    })
    expect(bad).rejects.toMatchObject({ kind: "not-found" })
  })
})

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})
