import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  addArtifactVersion,
  appendThread,
  appendThreadMessage,
  countOpenThreads,
  createArtifact,
  listArtifacts,
  openStore,
  readArtifactMeta,
  readFeedbackDoc,
  readFeedbackView,
  setArtifactStatus,
  setThreadStatus,
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
  it("creates an artifact with v1 file and review status", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, {
      title: "Dashboard redesign",
      prompt: "a metrics dashboard",
      html: "<h1 id=\"hero\">Hello</h1>",
    })
    expect(meta.status).toBe("review")
    expect(meta.current).toBe("v1")
    expect(meta.versions).toHaveLength(1)
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

  it("adds versions and moves current forward", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Deck", prompt: "", html: "<p>v1</p>" })
    const updated = await addArtifactVersion(store, meta.id, { html: "<p>v2</p>", note: "second pass" })
    expect(updated.current).toBe("v2")
    expect(updated.status).toBe("review")
    expect(updated.versions).toHaveLength(2)
    expect(updated.versions[1]?.note).toBe("second pass")
    expect(readFileSync(join(store.artifactsDir, meta.id, "v1", "index.html"), "utf8")).toBe("<p>v1</p>")
    expect(readFileSync(join(store.artifactsDir, meta.id, "v2", "index.html"), "utf8")).toBe("<p>v2</p>")
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

  it("appends messages and toggles thread status", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Page", prompt: "", html: "<p>x</p>" })
    const thread = await appendThread(store, meta.id, {
      version: "v1",
      anchor: null,
      body: "thoughts",
      author: "user",
    })
    const replied = await appendThreadMessage(store, meta.id, thread.id, {
      body: "good catch",
      author: "agent",
    })
    expect(replied.messages).toHaveLength(2)
    expect(replied.messages[1]?.author).toBe("agent")
    const resolved = await setThreadStatus(store, meta.id, thread.id, "resolved")
    expect(resolved.status).toBe("resolved")
    const reopened = await setThreadStatus(store, meta.id, thread.id, "open")
    expect(reopened.status).toBe("open")
  })

  it("sets artifact status", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Page", prompt: "", html: "<p>x</p>" })
    const approved = await setArtifactStatus(store, meta.id, "approved")
    expect(approved.status).toBe("approved")
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
    await addArtifactVersion(store, meta.id, { html: "<p>2</p>" })
    const openThread = await appendThread(store, meta.id, {
      version: "v1",
      anchor: null,
      body: "open on v1",
      author: "user",
    })
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
    await addArtifactVersion(store, meta.id, { html: "<p>2</p>" })

    const view = await readFeedbackView(store, meta.id)
    expect(view.version).toBe("v2")
    expect(view.threads).toHaveLength(1)
    expect(view.threads[0]?.anchorVersion).toBe("v1")
    expect(view.updatedAt).not.toBe("1970-01-01T00:00:00.000Z")

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

  it("sorts the view open-first and derives anchor versions for legacy threads", async () => {
    const store = makeStore()
    const meta = await createArtifact(store, { title: "Page", prompt: "", html: "<p>1</p>" })
    const first = await appendThread(store, meta.id, {
      version: "v1",
      anchor: null,
      body: "resolved one",
      author: "user",
    })
    const second = await appendThread(store, meta.id, {
      version: "v1",
      anchor: null,
      body: "open one",
      author: "user",
    })
    await setThreadStatus(store, meta.id, first.id, "resolved")

    // Rewrite the first thread as legacy JSON without anchorVersion.
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
