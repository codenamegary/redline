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

const MessageSchema = z.object({
  id: z.string(),
  author: z.string(),
  kind: z.string().optional(),
  body: z.string(),
})

const ThreadSchema = z.object({
  id: z.string(),
  status: z.string(),
  anchor: z.unknown().nullable(),
  anchorVersion: z.string().optional(),
  resolvedInVersion: z.string().optional(),
  messages: z.array(MessageSchema),
})

const ViewSchema = z.object({
  version: z.string(),
  current: z.string(),
  artifactStatus: z.string(),
  artifactUpdatedAt: z.string(),
  updatedAt: z.string(),
  iteratedAt: z.string(),
  agentAttached: z.boolean().optional(),
  approvedAt: z.string().optional(),
  versions: z.array(
    z.object({
      version: z.string(),
      note: z.string().optional(),
      publishedAt: z.string().optional(),
      approvedAt: z.string().optional(),
      batch: z.object({ threadIds: z.array(z.string()) }).optional(),
    }),
  ),
  threads: z.array(ThreadSchema),
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

const createThread = async (artifactId: string, body: string) => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/artifacts/" + artifactId + "/feedback",
    payload: { body: body },
  })
  expect(response.statusCode).toBe(201)
  return ThreadSchema.parse(response.json())
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
      .object({
        prompt: z.string(),
        iteratedAt: z.unknown().nullable(),
        versions: z.array(z.object({ version: z.string(), publishedAt: z.string().optional() })),
      })
      .parse(detail.json())
    expect(detailBody.prompt).toBe("")
    expect(detailBody.versions[0]?.version).toBe("v1")
    expect(detailBody.versions[0]?.publishedAt).toBeDefined()
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
    expect(shell.body).toContain("iterate")

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
    const viewBody = ViewSchema.parse(view.json())
    expect(viewBody.threads[0]?.status).toBe("resolved")
    expect(viewBody.artifactStatus).toBe("review")
    expect(viewBody.agentAttached).toBe(false)
    expect(viewBody.versions).toHaveLength(1)
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

  it("runs the full turn-based loop: iterate, publish, approve", async () => {
    const created = await createArtifact("Loop test", "<p>v1 body</p>")

    // Publishing before Iterate is the 409 gate.
    const early = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/versions",
      payload: { html: "<p>early</p>" },
    })
    expect(early.statusCode).toBe(409)

    // Iterating with nothing open is a 422.
    const empty = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/iterations",
      payload: {},
    })
    expect(empty.statusCode).toBe(422)

    const thread = await createThread(created.id, "please add a footer")

    const iterated = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/iterations",
      payload: {},
    })
    expect(iterated.statusCode).toBe(201)
    const iteration = z
      .object({
        status: z.string(),
        openThreads: z.number(),
        version: z.object({ version: z.string(), batch: z.object({ threadIds: z.array(z.string()) }) }),
      })
      .parse(iterated.json())
    expect(iteration.status).toBe("iterating")
    expect(iteration.openThreads).toBe(1)
    expect(iteration.version.version).toBe("v2")
    expect(iteration.version.batch.threadIds).toEqual([thread.id])

    // While iterating: new comments and resolutions are locked, replies are not.
    const newThread = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/feedback",
      payload: { body: "locked" },
    })
    expect(newThread.statusCode).toBe(409)
    const resolve = await app.inject({
      method: "PATCH",
      url: "/api/v1/artifacts/" + created.id + "/threads/" + thread.id,
      payload: { status: "resolved" },
    })
    expect(resolve.statusCode).toBe(409)
    const reply = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/threads/" + thread.id + "/messages",
      payload: { body: "on it \u2014 footer lands in v2", author: "agent" },
    })
    expect(reply.statusCode).toBe(201)

    // Approval waits for the round to finish.
    const earlyApprove = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/versions/v2/approve",
      payload: {},
    })
    expect(earlyApprove.statusCode).toBe(409)

    const published = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/versions",
      payload: { html: "<p>v2 body</p>", note: "footer added" },
    })
    expect(published.statusCode).toBe(201)
    const summary = SummarySchema.parse(published.json())
    expect(summary.status).toBe("review")
    expect(summary.current).toBe("v2")
    expect(summary.versionCount).toBe(2)

    const oldVersion = await app.inject({ method: "GET", url: "/a/" + created.id + "/v1/index.html" })
    expect(oldVersion.body).toContain("v1 body")
    const newVersion = await app.inject({ method: "GET", url: "/a/" + created.id + "/v2/index.html" })
    expect(newVersion.body).toContain("v2 body")

    const wrongVersion = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/versions/v1/approve",
      payload: {},
    })
    expect(wrongVersion.statusCode).toBe(404)

    const approved = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/versions/v2/approve",
      payload: {},
    })
    expect(approved.statusCode).toBe(200)
    const approvedRow = z.object({ version: z.string(), approvedAt: z.string() }).parse(approved.json())
    expect(approvedRow.approvedAt).toBeDefined()

    // Approval is data: the artifact stays in review and still iterable.
    const view = await app.inject({ method: "GET", url: "/api/v1/artifacts/" + created.id + "/feedback" })
    const viewBody = ViewSchema.parse(view.json())
    expect(viewBody.artifactStatus).toBe("review")
    expect(viewBody.approvedAt).toBeDefined()
    expect(viewBody.versions[1]?.note).toBe("footer added")
    expect(viewBody.versions[1]?.approvedAt).toBeDefined()
    expect(viewBody.versions[1]?.batch?.threadIds).toEqual([thread.id])
  })

  it("keeps threads visible across versions with pinned-on and resolved-in markers", async () => {
    const created = await createArtifact("Cross version", "<p>v1</p>")
    const thread = await createThread(created.id, "pinned on v1")
    expect(thread.anchorVersion).toBe("v1")

    const badVersion = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/feedback",
      payload: { body: "nowhere", version: "v9" },
    })
    expect(badVersion.statusCode).toBe(404)

    await app.inject({ method: "POST", url: "/api/v1/artifacts/" + created.id + "/iterations", payload: {} })
    const added = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/versions",
      payload: { html: "<p>v2</p>" },
    })
    expect(SummarySchema.parse(added.json()).current).toBe("v2")

    const view = await app.inject({ method: "GET", url: "/api/v1/artifacts/" + created.id + "/feedback" })
    const body = ViewSchema.parse(view.json())
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
    const resolvedBody = ViewSchema.parse(resolvedView.json())
    expect(resolvedBody.threads[0]?.resolvedInVersion).toBe("v2")

    const v1View = await app.inject({
      method: "GET",
      url: "/api/v1/artifacts/" + created.id + "/feedback?version=v1",
    })
    const v1Body = ViewSchema.parse(v1View.json())
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
    const thread = await createThread(created.id, "comment one")

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
    const body = ViewSchema.parse(polled.json())
    expect(body.threads[0]?.status).toBe("resolved")
    expect(body.agentAttached).toBe(true)
  })

  it("wakes a long-poll when an iteration is submitted", async () => {
    const created = await createArtifact("Iterate poll test", "<p>x</p>")
    await createThread(created.id, "iterate me")

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
    const iterated = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/iterations",
      payload: {},
    })
    expect(iterated.statusCode).toBe(201)
    const polled = await poller
    expect(polled.statusCode).toBe(200)
    const body = ViewSchema.parse(polled.json())
    expect(body.artifactStatus).toBe("iterating")
    expect(body.iteratedAt).not.toBe("1970-01-01T00:00:00.000Z")
    expect(body.versions[1]?.batch?.threadIds).toHaveLength(1)
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
    expect(ViewSchema.parse(response.json()).artifactStatus).toBe("review")
  })

  it("inserts thinking placeholders only while attached and in review", async () => {
    const created = await createArtifact("Placeholder test", "<p>x</p>")

    // Not attached: plain comment, no placeholder.
    const detached = await createThread(created.id, "nobody is home")
    expect(detached.messages).toHaveLength(1)

    // Attach a waiter, then comment: the server answers with a placeholder.
    const after = new Date(Date.now() + 50_000).toISOString()
    const poller = app.inject({
      method: "GET",
      url:
        "/api/v1/artifacts/" +
        created.id +
        "/feedback?wait=2&after=" +
        encodeURIComponent(after),
    })
    await sleep(300)

    const attached = await createThread(created.id, "now somebody is home")
    expect(attached.messages).toHaveLength(2)
    expect(attached.messages[1]?.kind).toBe("thinking")
    expect(attached.messages[1]?.author).toBe("agent")

    // The agent replaces the placeholder with a real answer.
    const placeholderId = attached.messages[1]?.id
    const patched = await app.inject({
      method: "PATCH",
      url:
        "/api/v1/artifacts/" +
        created.id +
        "/threads/" +
        attached.id +
        "/messages/" +
        placeholderId,
      payload: { body: "will fold this into the next iteration" },
    })
    expect(patched.statusCode).toBe(200)
    const answered = ThreadSchema.parse(patched.json())
    expect(answered.messages[1]?.kind).toBe("text")
    expect(answered.messages[1]?.body).toBe("will fold this into the next iteration")

    // Placeholders are the only editable messages.
    const userMessage = await app.inject({
      method: "PATCH",
      url:
        "/api/v1/artifacts/" +
        created.id +
        "/threads/" +
        attached.id +
        "/messages/" +
        attached.messages[0]?.id,
      payload: { body: "rewriting history" },
    })
    expect(userMessage.statusCode).toBe(404)

    // Replies to an attached thread get their own placeholder.
    const reply = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/threads/" + attached.id + "/messages",
      payload: { body: "thanks" },
    })
    const replied = ThreadSchema.parse(reply.json())
    expect(replied.messages[replied.messages.length - 1]?.kind).toBe("thinking")

    await poller
    const view = await app.inject({ method: "GET", url: "/api/v1/artifacts/" + created.id + "/feedback" })
    expect(ViewSchema.parse(view.json()).agentAttached).toBe(false)
  })
})
