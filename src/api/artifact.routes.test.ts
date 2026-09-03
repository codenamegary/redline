import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

import { buildServer } from "../server"
import { openStore } from "../store/artifact.store"

const home = mkdtempSync(join(tmpdir(), "redline-routes-"))
const app = buildServer({ store: openStore(home), loggerLevel: "error" })

afterAll(async () => {
  await app.close()
  rmSync(home, { recursive: true, force: true })
})

const SummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  current: z.string(),
  versionCount: z.number(),
  openThreads: z.number(),
  reviewUrl: z.string(),
})

const ThreadSchema = z.object({
  id: z.string(),
  status: z.string(),
  anchor: z.unknown().nullable(),
  anchorVersion: z.string().optional(),
  resolvedInVersion: z.string().optional(),
  messages: z.array(z.object({ id: z.string(), author: z.string(), body: z.string() })),
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const createArtifact = async (title: string, html: string): Promise<z.infer<typeof SummarySchema>> => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/artifacts",
    payload: { title: title, html: html },
  })
  if (response.statusCode !== 201) throw new Error("fixture create failed: " + response.body)
  return SummarySchema.parse(response.json())
}

describe("artifact api", () => {
  it("reports health", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/health" })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ ok: true, service: "redline" })
  })

  it("creates, lists, and shows artifacts", async () => {
    const created = await createArtifact("Landing page", "<h1 id=\"hero\">Landing</h1>")
    expect(created.status).toBe("review")
    expect(created.current).toBe("v1")
    expect(created.versionCount).toBe(1)
    expect(created.openThreads).toBe(0)
    expect(created.reviewUrl).toContain("/a/" + created.id)

    const listed = await app.inject({ method: "GET", url: "/api/v1/artifacts" })
    expect(listed.statusCode).toBe(200)
    const summaries = z.array(SummarySchema).parse(listed.json())
    expect(summaries.map((summary) => summary.id)).toContain(created.id)

    const detail = await app.inject({ method: "GET", url: "/api/v1/artifacts/" + created.id })
    expect(detail.statusCode).toBe(200)
    const detailBody = z
      .object({ prompt: z.string(), versions: z.array(z.object({ version: z.string() })) })
      .parse(detail.json())
    expect(detailBody.prompt).toBe("")
    expect(detailBody.versions[0]?.version).toBe("v1")
  })

  it("rejects invalid bodies with problem details", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts",
      payload: { title: "", html: "" },
    })
    expect(response.statusCode).toBe(400)
    expect(response.headers["content-type"]).toContain("application/problem+json")
    expect(response.json()).toMatchObject({ type: "about:blank", status: 400 })
  })

  it("serves raw artifact files, the shell, and the gallery", async () => {
    const created = await createArtifact("Serving test", "<h1>Raw body marker</h1>")

    const raw = await app.inject({ method: "GET", url: "/a/" + created.id + "/v1/index.html" })
    expect(raw.statusCode).toBe(200)
    expect(raw.headers["content-type"]).toContain("text/html")
    expect(raw.body).toContain("Raw body marker")

    const bare = await app.inject({ method: "GET", url: "/a/" + created.id + "/v1/" })
    expect(bare.statusCode).toBe(200)
    expect(bare.body).toContain("Raw body marker")

    const current = await app.inject({ method: "GET", url: "/a/" + created.id + "/current/index.html" })
    expect(current.statusCode).toBe(200)

    const shell = await app.inject({ method: "GET", url: "/a/" + created.id })
    expect(shell.statusCode).toBe(200)
    expect(shell.headers["content-type"]).toContain("text/html")
    expect(shell.body).toContain("redline-data")
    expect(shell.body).toContain("Serving test")

    const gallery = await app.inject({ method: "GET", url: "/" })
    expect(gallery.statusCode).toBe(200)
    expect(gallery.body).toContain("Serving test")
    expect(gallery.body).toContain(created.id)
  })

  it("blocks path traversal in static file requests", async () => {
    const created = await createArtifact("Traversal test", "<h1>x</h1>")
    const response = await app.inject({
      method: "GET",
      url: "/a/" + created.id + "/v1/%2e%2e/%2e%2e/meta.json",
    })
    // Fastify rejects encoded traversal with 400 before the route handler runs;
    // the store-level guard would answer 404. Either way the file is not served.
    expect([400, 404]).toContain(response.statusCode)
    expect(response.body).not.toContain("meta")
  })

  it("returns problem details for unknown artifacts", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/artifacts/2099-01-01-000000-nope" })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ type: "about:blank", status: 404 })
  })

  it("collects feedback threads, replies, and resolution", async () => {
    const created = await createArtifact("Feedback test", "<h1 id=\"hero\">Hero</h1>")

    const threadResponse = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/feedback",
      payload: {
        anchor: { selector: "#hero", text: "Hero", rect: { x: 10, y: 20, width: 30, height: 40 } },
        body: "too big",
      },
    })
    expect(threadResponse.statusCode).toBe(201)
    expect(threadResponse.headers.location).toContain("/threads/")
    const thread = ThreadSchema.parse(threadResponse.json())
    expect(thread.status).toBe("open")
    expect(thread.messages[0]?.body).toBe("too big")

    const replyResponse = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/threads/" + thread.id + "/messages",
      payload: { body: "shrinking it", author: "agent" },
    })
    expect(replyResponse.statusCode).toBe(201)
    const replied = ThreadSchema.parse(replyResponse.json())
    expect(replied.messages).toHaveLength(2)
    expect(replied.messages[1]?.author).toBe("agent")

    const resolveResponse = await app.inject({
      method: "PATCH",
      url: "/api/v1/artifacts/" + created.id + "/threads/" + thread.id,
      payload: { status: "resolved" },
    })
    expect(resolveResponse.statusCode).toBe(200)
    expect(ThreadSchema.parse(resolveResponse.json()).status).toBe("resolved")

    const view = await app.inject({ method: "GET", url: "/api/v1/artifacts/" + created.id + "/feedback" })
    const viewBody = z
      .object({
        threads: z.array(ThreadSchema),
        artifactStatus: z.string(),
        artifactUpdatedAt: z.string(),
      })
      .parse(view.json())
    expect(viewBody.threads[0]?.status).toBe("resolved")
    expect(viewBody.artifactStatus).toBe("review")
  })

  it("creates a general comment without an anchor", async () => {
    const created = await createArtifact("General test", "<p>x</p>")
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/feedback",
      payload: { body: "overall vibe is off" },
    })
    expect(response.statusCode).toBe(201)
    const thread = ThreadSchema.parse(response.json())
    expect(thread.anchor).toBeNull()
    expect(thread.messages[0]?.author).toBe("user")
  })

  it("keeps threads visible across versions with pinned-on and resolved-in markers", async () => {
    const created = await createArtifact("Cross version", "<p>v1</p>")
    const threadResponse = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/feedback",
      payload: { body: "pinned on v1" },
    })
    expect(threadResponse.statusCode).toBe(201)
    const thread = ThreadSchema.parse(threadResponse.json())
    expect(thread.anchorVersion).toBe("v1")

    const badVersion = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/feedback",
      payload: { body: "nowhere", version: "v9" },
    })
    expect(badVersion.statusCode).toBe(404)

    const added = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/versions",
      payload: { html: "<p>v2</p>" },
    })
    expect(SummarySchema.parse(added.json()).current).toBe("v2")

    const view = await app.inject({ method: "GET", url: "/api/v1/artifacts/" + created.id + "/feedback" })
    const body = z
      .object({ version: z.string(), threads: z.array(ThreadSchema) })
      .parse(view.json())
    expect(body.version).toBe("v2")
    expect(body.threads).toHaveLength(1)
    expect(body.threads[0]?.anchorVersion).toBe("v1")

    await app.inject({
      method: "PATCH",
      url: "/api/v1/artifacts/" + created.id + "/threads/" + thread.id,
      payload: { status: "resolved" },
    })
    const resolvedView = await app.inject({
      method: "GET",
      url: "/api/v1/artifacts/" + created.id + "/feedback",
    })
    const resolvedBody = z.object({ threads: z.array(ThreadSchema) }).parse(resolvedView.json())
    expect(resolvedBody.threads[0]?.resolvedInVersion).toBe("v2")

    const v1View = await app.inject({
      method: "GET",
      url: "/api/v1/artifacts/" + created.id + "/feedback?version=v1",
    })
    const v1Body = z.object({ version: z.string(), threads: z.array(ThreadSchema) }).parse(v1View.json())
    expect(v1Body.version).toBe("v1")
    expect(v1Body.threads).toHaveLength(1)

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/artifacts/" + created.id + "/feedback?version=v9",
    })
    expect(missing.statusCode).toBe(404)
  })

  it("wakes a long-poll when feedback changes", async () => {
    const created = await createArtifact("Poll test", "<p>x</p>")
    const threadResponse = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/feedback",
      payload: { body: "comment one" },
    })
    const thread = ThreadSchema.parse(threadResponse.json())

    const after = new Date(Date.now() + 80).toISOString()
    const poller = app.inject({
      method: "GET",
      url:
        "/api/v1/artifacts/" +
        created.id +
        "/feedback?wait=5&after=" +
        encodeURIComponent(after),
    })
    await sleep(300)
    await app.inject({
      method: "PATCH",
      url: "/api/v1/artifacts/" + created.id + "/threads/" + thread.id,
      payload: { status: "resolved" },
    })
    const polled = await poller
    expect(polled.statusCode).toBe(200)
    const body = z.object({ threads: z.array(ThreadSchema) }).parse(polled.json())
    expect(body.threads[0]?.status).toBe("resolved")
  })

  it("times out a long-poll without changes", async () => {
    const created = await createArtifact("Poll timeout test", "<p>x</p>")
    const after = new Date(Date.now() + 50_000).toISOString()
    const started = Date.now()
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/artifacts/" + created.id + "/feedback?wait=1&after=" + encodeURIComponent(after),
    })
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(response.statusCode).toBe(200)
    expect(z.object({ artifactStatus: z.string() }).parse(response.json()).artifactStatus).toBe("review")
  })

  it("adds versions and approves", async () => {
    const created = await createArtifact("Version test", "<p>v1 body</p>")
    const added = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/versions",
      payload: { html: "<p>v2 body</p>", note: "second pass" },
    })
    expect(added.statusCode).toBe(201)
    const summary = SummarySchema.parse(added.json())
    expect(summary.current).toBe("v2")
    expect(summary.versionCount).toBe(2)

    const oldVersion = await app.inject({ method: "GET", url: "/a/" + created.id + "/v1/index.html" })
    expect(oldVersion.body).toContain("v1 body")
    const newVersion = await app.inject({ method: "GET", url: "/a/" + created.id + "/v2/index.html" })
    expect(newVersion.body).toContain("v2 body")

    const approved = await app.inject({
      method: "PATCH",
      url: "/api/v1/artifacts/" + created.id,
      payload: { status: "approved" },
    })
    expect(approved.statusCode).toBe(200)
    expect(SummarySchema.parse(approved.json()).status).toBe("approved")
  })
})
