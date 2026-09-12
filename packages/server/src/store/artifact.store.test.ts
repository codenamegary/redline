import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  approveVersion,
  appendThread,
  appendThreadMessage,
  assetFilename,
  countOpenThreads,
  createArtifact,
  listArtifacts,
  listVersionAssets,
  maxAssetBytes,
  openStore,
  publishIteration,
  readArtifactMeta,
  readFeedbackDoc,
  readFeedbackView,
  replaceThinkingMessage,
  rollbackIteration,
  saveVersionAsset,
  setThreadStatus,
  startIteration,
  Store,
  touchIteration,
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
    const html = readFileSync(join(store.artifactsDir, meta.id, "v1-index.html"), "utf8")
    expect(html).toBe("<h1 id=\"hero\">Hello</h1>")
    const stored = JSON.parse(readFileSync(join(store.artifactsDir, meta.id, "meta.json"), "utf8")) as {
      id: string
    }
    expect(stored.id).toBe(meta.id)
  })

  it("strips redline session-name prefixes from the title at creation", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "redline - Fix nav overlap", prompt: "", html: "<p>x</p>" })
    expect(meta.title).toBe("Fix nav overlap")
    const reread = await readArtifactMeta(store, meta.id)
    expect(reread.title).toBe("Fix nav overlap")
  })

  it("reads meta.json with iteratedAt null (never iterated)", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Fresh", prompt: "", html: "<p>v1</p>" })
    const metaPath = join(store.artifactsDir, meta.id, "meta.json")
    writeFileSync(metaPath, JSON.stringify({ ...meta, iteratedAt: null }))
    const reread = await readArtifactMeta(store, meta.id)
    expect(reread.iteratedAt).toBeNull()
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
    expect(readFileSync(join(store.artifactsDir, meta.id, "v1-index.html"), "utf8")).toBe("<p>v1</p>")
    expect(readFileSync(join(store.artifactsDir, meta.id, "v2-index.html"), "utf8")).toBe("<p>v2</p>")
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
    await new Promise((resolve) => setTimeout(resolve, 10))
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

  it("stamps heartbeat and host session on the pending batch", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Page", prompt: "", html: "<p>1</p>" })
    await appendThread(store, meta.id, { version: "v1", anchor: null, body: "fix", author: "user" })
    await startIteration(store, meta.id)

    await touchIteration(store, meta.id, { adapterId: "acp", sessionId: "acp-a1-1" })
    const first = (await readArtifactMeta(store, meta.id)).versions.find((row) => row.batch !== undefined)
    expect(first?.batch?.adapterId).toBe("acp")
    expect(first?.batch?.sessionId).toBe("acp-a1-1")
    expect(first?.batch?.heartbeatAt).toBeDefined()

    await new Promise((resolve) => setTimeout(resolve, 5))
    await touchIteration(store, meta.id)
    const second = (await readArtifactMeta(store, meta.id)).versions.find((row) => row.batch !== undefined)
    expect(second?.batch?.heartbeatAt && first?.batch?.heartbeatAt).toBeDefined()
    expect(Date.parse(second?.batch?.heartbeatAt ?? "")).toBeGreaterThan(Date.parse(first?.batch?.heartbeatAt ?? ""))

    // A touch after publish is a no-op: there is nothing pending.
    await publishIteration(store, meta.id, { html: "<p>2</p>" })
    await touchIteration(store, meta.id, { adapterId: "x", sessionId: "y" })
    const published = await readArtifactMeta(store, meta.id)
    expect(published.status).toBe("review")
    expect(published.versions[0]?.batch?.sessionId).toBeUndefined()
  })

  it("rolls a pending iteration back to review and frees the version number", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Page", prompt: "", html: "<p>1</p>" })
    const thread = await appendThread(store, meta.id, {
      version: "v1",
      anchor: null,
      body: "still broken",
      author: "user",
    })
    await startIteration(store, meta.id)

    const rolled = await rollbackIteration(store, meta.id)
    expect(rolled.status).toBe("review")
    expect(rolled.versions).toHaveLength(1)
    expect((await readFeedbackView(store, meta.id)).threads[0]?.status).toBe("open")

    // Rollback is rejected outside an iterating round.
    let conflict: unknown
    try {
      await rollbackIteration(store, meta.id)
    } catch (error) {
      conflict = error
    }
    expect(isStoreError(conflict)).toBe(true)

    // Re-iterating after a rollback reuses the version number cleanly.
    const round = await startIteration(store, meta.id)
    expect(round.version.version).toBe("v2")
    await publishIteration(store, meta.id, { html: "<p>2</p>" })
    await setThreadStatus(store, meta.id, thread.id, "resolved")
    expect((await readArtifactMeta(store, meta.id)).current).toBe("v2")
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
    const path = join(store.artifactsDir, meta.id, "v1-feedback.json")
    const raw = JSON.parse(readFileSync(path, "utf8")) as { threads: Array<{ anchorVersion?: string }> }
    delete raw.threads[0]?.anchorVersion
    writeFileSync(path, JSON.stringify(raw), "utf8")

    const view = await readFeedbackView(store, meta.id)
    expect(view.threads[0]?.id).toBe(second.id)
    expect(view.threads[1]?.id).toBe(first.id)
    expect(view.threads[1]?.anchorVersion).toBe("v1")
  })

  it("yields stable marker numbers when threads sort oldest-first by createdAt", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Page", prompt: "", html: "<p>1</p>" })
    // Anchor-bearing open threads, the kind the review UI numbers.
    const anchor = { selector: "#pin", text: "pin", rect: { x: 1, y: 2, width: 3, height: 4 } }
    const first = await appendThread(store, meta.id, {
      version: "v1",
      anchor,
      body: "one",
      author: "user",
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = await appendThread(store, meta.id, {
      version: "v1",
      anchor,
      body: "two",
      author: "user",
    })
    // The UI derives numbers from an ascending createdAt sort (id breaks
    // ties). The older threads must keep numbers 1 and 2 when a newer
    // comment arrives.
    const numbers = (view: Awaited<ReturnType<typeof readFeedbackView>>): Map<string, number> =>
      new Map(
        [...view.threads]
          .sort(
            (a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          )
          .map((thread, index) => [thread.id, index + 1]),
      )
    const before = numbers(await readFeedbackView(store, meta.id))
    expect(before.get(first.id)).toBe(1)
    expect(before.get(second.id)).toBe(2)

    await new Promise((resolve) => setTimeout(resolve, 10))
    const third = await appendThread(store, meta.id, {
      version: "v1",
      anchor,
      body: "three",
      author: "user",
    })
    const after = numbers(await readFeedbackView(store, meta.id))
    expect(after.get(first.id)).toBe(1)
    expect(after.get(second.id)).toBe(2)
    expect(after.get(third.id)).toBe(3)
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

  it("saves version assets, lists them, and records them on the version row", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Assets", prompt: "", html: "<img src=\"hero.png\">" })
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const first = await saveVersionAsset(store, meta.id, "v1", "hero.png", bytes)
    expect(first.filename).toBe("hero.png")
    expect(first.assets).toEqual(["hero.png"])

    const second = await saveVersionAsset(store, meta.id, "v1", "banner.webp", new Uint8Array([1]))
    // Sorted, not insertion order: the list is deterministic for meta and UI.
    expect(second.assets).toEqual(["banner.webp", "hero.png"])
    expect(await listVersionAssets(store, meta.id, "v1")).toEqual(["banner.webp", "hero.png"])
    expect(await listVersionAssets(store, meta.id, "v9")).toEqual([])

    const onDisk = readFileSync(join(store.artifactsDir, meta.id, "v1-assets", "hero.png"))
    expect(Array.from(onDisk)).toEqual([0x89, 0x50, 0x4e, 0x47])

    const fresh = await readArtifactMeta(store, meta.id)
    expect(fresh.versions[0]?.assets).toEqual(["banner.webp", "hero.png"])
  })

  it("rejects invalid asset filenames, unknown versions, duplicates, and oversize bytes", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Asset guards", prompt: "", html: "<p>x</p>" })
    const bytes = new Uint8Array([1])

    expect(saveVersionAsset(store, meta.id, "v1", "../evil.png", bytes)).rejects.toMatchObject({
      kind: "unprocessable",
    })
    expect(saveVersionAsset(store, meta.id, "v1", "sub/dir.png", bytes)).rejects.toMatchObject({
      kind: "unprocessable",
    })
    expect(saveVersionAsset(store, meta.id, "v1", "noext", bytes)).rejects.toMatchObject({
      kind: "unprocessable",
    })
    expect(saveVersionAsset(store, meta.id, "v1", "virus.exe", bytes)).rejects.toMatchObject({
      kind: "unprocessable",
    })
    expect(saveVersionAsset(store, meta.id, "v9", "hero.png", bytes)).rejects.toMatchObject({
      kind: "not-found",
    })
    expect(
      saveVersionAsset(store, "2099-01-01-000000-nope", "v1", "hero.png", bytes),
    ).rejects.toMatchObject({ kind: "not-found" })

    await saveVersionAsset(store, meta.id, "v1", "hero.png", bytes)
    expect(saveVersionAsset(store, meta.id, "v1", "hero.png", bytes)).rejects.toMatchObject({
      kind: "conflict",
    })
    expect(
      saveVersionAsset(store, meta.id, "v1", "big.png", new Uint8Array(maxAssetBytes + 1)),
    ).rejects.toMatchObject({ kind: "unprocessable" })
    expect(saveVersionAsset(store, meta.id, "v1", "empty.png", new Uint8Array(0))).rejects.toMatchObject({
      kind: "unprocessable",
    })
  })

  it("validates asset names the same way serving does", () => {
    expect(assetFilename("hero.png")).toBe("hero.png")
    expect(assetFilename("HERO-2.webp")).toBe("HERO-2.webp")
    expect(() => assetFilename("../meta.json")).toThrow()
    expect(() => assetFilename("a/b.png")).toThrow()
    expect(() => assetFilename(".hidden.png")).toThrow()
  })
})

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})
