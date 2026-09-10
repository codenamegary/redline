import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { Buffer } from "node:buffer"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

import { FastifyInstance } from "fastify"

import { buildServer } from "../server"
import { openStore, startIteration } from "../store/artifact.store"
import { workerRuntime, DispatcherAdapters } from "../worker/dispatcher"
import { ArtifactMetaSchema } from "@redline/http-contracts/artifact.models"
import {
  AgentSession,
  DutyInput,
  DutyResult,
  HostAdapter,
  Lane,
  SeedSpec,
} from "../worker/host.adapter"
import { DEFAULT_REVIEWER_PROMPT, DEFAULT_WORKER_PROMPT } from "../worker/prompts"

const home = mkdtempSync(join(tmpdir(), "redline-routes-"))
// Lane dispatch now keys off settings (default adapter is "acp"); this shared
// fixture pins both lanes off so the plain HTTP tests keep their detached
// semantics. Lane integration gets its own server below.
writeFileSync(
  join(home, "settings.json"),
  JSON.stringify({
    reviewer: { adapter: "none", preset: "custom", acpCommand: ["unused"] },
    worker: { adapter: "none", preset: "custom", acpCommand: ["unused"] },
    prompts: { reviewer: "", worker: "" },
  }),
)
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
  reviewer: z.string(),
  worker: z.string(),
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
  reviewerAttached: z.boolean().optional(),
  workerRunning: z.boolean().optional(),
  workerLive: z.boolean().optional(),
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
    // The detail route is what the UI parses with ArtifactMetaSchema; before
    // iteratedAt went nullish this parse rejected never-iterated artifacts.
    const detailBody = ArtifactMetaSchema.parse(detail.json())
    expect(detailBody.iteratedAt).toBeNull()
    const detailWire = z
      .object({
        prompt: z.string(),
        iteratedAt: z.unknown().nullable(),
        versions: z.array(z.object({ version: z.string(), publishedAt: z.string().optional() })),
      })
      .parse(detail.json())
    expect(detailWire.prompt).toBe("")
    expect(detailWire.versions[0]?.version).toBe("v1")
    expect(detailWire.versions[0]?.publishedAt).toBeDefined()
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

  it("serves raw artifact files and hands page paths to the SPA fallback", async () => {
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

    // Page paths belong to the SPA now: JSON clients get problem+json, HTML
    // navigations get the fallback shell (or the build-missing hint page).
    const jsonClient = await app.inject({ method: "GET", url: "/a/" + created.id })
    expect(jsonClient.statusCode).toBe(404)
    expect(jsonClient.headers["content-type"]).toContain("application/problem+json")

    const htmlClient = await app.inject({
      method: "GET",
      url: "/a/" + created.id,
      headers: { accept: "text/html" },
    })
    expect(htmlClient.statusCode).toBe(200)
    expect(htmlClient.headers["content-type"]).toContain("text/html")
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
    expect(response.headers["content-type"]).toContain("application/problem+json")
    expect(response.body).not.toContain("createdAt")
    expect(response.body).not.toContain("Traversal test")
  })

  it("uploads version assets and serves them on the version path", async () => {
    const created = await createArtifact("Asset test", "<img src=\"hero.png\">")
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    const data = Buffer.from(bytes).toString("base64")

    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/assets",
      payload: { version: "v1", filename: "hero.png", data },
    })
    expect(upload.statusCode).toBe(201)
    const asset = z
      .object({
        artifactId: z.string(),
        version: z.string(),
        filename: z.string(),
        size: z.number(),
        url: z.string(),
      })
      .parse(upload.json())
    expect(asset).toMatchObject({ artifactId: created.id, version: "v1", filename: "hero.png", size: bytes.byteLength })
    expect(asset.url).toContain("/a/" + created.id + "/v1/hero.png")
    expect(upload.headers.location).toBe(asset.url)

    const served = await app.inject({ method: "GET", url: "/a/" + created.id + "/v1/hero.png" })
    expect(served.statusCode).toBe(200)
    expect(served.headers["content-type"]).toContain("image/png")
    // LightMyRequest exposes the untouched bytes on rawPayload.
    expect(Array.from(served.rawPayload as unknown as Uint8Array)).toEqual(Array.from(bytes))

    const viaCurrent = await app.inject({ method: "GET", url: "/a/" + created.id + "/current/hero.png" })
    expect(viaCurrent.statusCode).toBe(200)

    // The version ledger records the asset, and the html path keeps working.
    const detail = await app.inject({ method: "GET", url: "/api/v1/artifacts/" + created.id })
    const detailBody = z
      .object({ versions: z.array(z.object({ version: z.string(), assets: z.array(z.string()).optional() })) })
      .parse(detail.json())
    expect(detailBody.versions[0]?.assets).toEqual(["hero.png"])

    // Summaries surface the asset count for the gallery.
    const listed = await app.inject({ method: "GET", url: "/api/v1/artifacts" })
    const withCount = z
      .object({ id: z.string(), assetsCount: z.number() })
      .parse(listed.json().find((item: { id: string }) => item.id === created.id))
    expect(withCount.assetsCount).toBe(1)

    const missing = await app.inject({ method: "GET", url: "/a/" + created.id + "/v1/nope.txt" })
    expect(missing.statusCode).toBe(404)
    expect(missing.headers["content-type"]).toContain("application/problem+json")
  })

  it("rejects bad asset uploads with the right problem details", async () => {
    const created = await createArtifact("Asset rejects", "<p>x</p>")
    const url = "/api/v1/artifacts/" + created.id + "/assets"
    const data = Buffer.from("png").toString("base64")

    const badName = await app.inject({ method: "POST", url, payload: { version: "v1", filename: "../evil.png", data } })
    expect(badName.statusCode).toBe(422)
    expect(badName.headers["content-type"]).toContain("application/problem+json")

    const badExt = await app.inject({ method: "POST", url, payload: { version: "v1", filename: "virus.exe", data } })
    expect(badExt.statusCode).toBe(422)

    const notBase64 = await app.inject({
      method: "POST",
      url,
      payload: { version: "v1", filename: "hero.png", data: "not base64!!!" },
    })
    expect(notBase64.statusCode).toBe(400)

    const badVersion = await app.inject({ method: "POST", url, payload: { version: "v9", filename: "hero.png", data } })
    expect(badVersion.statusCode).toBe(404)

    const badArtifact = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/2099-01-01-000000-nope/assets",
      payload: { version: "v1", filename: "hero.png", data },
    })
    expect(badArtifact.statusCode).toBe(404)

    const first = await app.inject({ method: "POST", url, payload: { version: "v1", filename: "hero.png", data } })
    expect(first.statusCode).toBe(201)
    const duplicate = await app.inject({ method: "POST", url, payload: { version: "v1", filename: "hero.png", data } })
    expect(duplicate.statusCode).toBe(409)
  })

  it("accepts asset uploads for a pending version before publish", async () => {
    const created = await createArtifact("Pending assets", "<p>v1</p>")
    await createThread(created.id, "add an image in v2")
    const iterated = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/iterations",
      payload: {},
    })
    expect(iterated.statusCode).toBe(201)

    const data = Buffer.from("gif-bytes").toString("base64")
    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/assets",
      payload: { version: "v2", filename: "chart.gif", data },
    })
    expect(upload.statusCode).toBe(201)

    const published = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/versions",
      payload: { html: "<img src=\"chart.gif\">", note: "with image" },
    })
    expect(published.statusCode).toBe(201)
    const served = await app.inject({ method: "GET", url: "/a/" + created.id + "/v2/chart.gif" })
    expect(served.statusCode).toBe(200)
    expect(served.headers["content-type"]).toContain("image/gif")
    expect(served.body).toContain("gif-bytes")
  })

  it("returns problem details for unknown artifacts", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/artifacts/2099-01-01-000000-nope" })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ type: "about:blank", status: 404 })
  })

  it("reports the worker debug view with unconfigured lanes and 404s unknown ids", async () => {
    const created = await createArtifact("Worker debug", "<p>dbg</p>")
    const response = await app.inject({ method: "GET", url: "/api/v1/artifacts/" + created.id + "/worker" })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      artifactId: created.id,
      attached: false,
      reviewer: { adapter: "none", bound: false },
      worker: { adapter: "none", running: false, bound: false },
    })

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/artifacts/2099-01-01-000000-nope/worker",
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ type: "about:blank", status: 404 })
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
    expect(viewBody.reviewerAttached).toBe(false)
    expect(viewBody.workerRunning).toBe(false)
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

  it("iterates without a configured worker and keeps the manual publish fallback", async () => {
    const created = await createArtifact("No worker iterate", "<p>nw v1</p>")
    expect(created.reviewer).toBe("none")
    expect(created.worker).toBe("none")

    await createThread(created.id, "make it better")
    const iterated = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/iterations",
      payload: {},
    })
    expect(iterated.statusCode).toBe(201)
    expect(z.object({ status: z.string() }).parse(iterated.json()).status).toBe("iterating")

    // No duty was dispatched: the fallback agent publishes through the API.
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/versions",
      payload: { html: "<p>nw v2</p>", note: "manual publish" },
    })
    expect(published.statusCode).toBe(201)
    expect(SummarySchema.parse(published.json()).current).toBe("v2")
  })
})

describe("agent lane dispatch", () => {
  const laneHome = mkdtempSync(join(tmpdir(), "redline-lanes-"))
  const laneStore = openStore(laneHome)
  let laneApp: FastifyInstance

  // Lane settings live on disk and are read at call time, so tests can flip
  // a lane mid-suite and restore this baseline afterwards.
  const laneSettings = (overrides?: { reviewer?: string; worker?: string }): string =>
    JSON.stringify({
      reviewer: {
        adapter: overrides?.reviewer ?? "acp",
        preset: "custom",
        acpCommand: ["fake-agent"],
      },
      worker: {
        adapter: overrides?.worker ?? "acp",
        preset: "custom",
        acpCommand: ["fake-agent"],
      },
      prompts: { reviewer: "", worker: "" },
    })

  // Duty bookkeeping. runDuty parks every duty on a deferred the test
  // resolves, so store mutations happen deterministically.
  const recorded: {
    duties: DutyInput[]
    seeds: (SeedSpec | undefined)[]
  } = { duties: [], seeds: [] }
  const pending: { promise: Promise<DutyResult>; resolve: (result: DutyResult) => void; reject: (error: Error) => void }[] = []

  const deferred = (): (typeof pending)[number] => {
    let resolve!: (result: DutyResult) => void
    let reject!: (error: Error) => void
    const promise = new Promise<DutyResult>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  const fakeResult = (input: DutyInput): DutyResult =>
    input.lane === "reviewer"
      ? {
          kind: "replies",
          items: input.targets.map((target) => ({ ...target, body: "reply:" + target.messageId })),
        }
      : { kind: "document", html: "<p>fake next</p>", note: "redline-note" }

  const fakeAcp: HostAdapter = {
    id: "acp",
    ensureSession: async (lane: Lane, artifactId: string, seed?: SeedSpec) => {
      recorded.seeds.push(seed)
      return { artifactId: artifactId, lane: lane, hostSessionId: "fake-1" }
    },
    runDuty: async (session: AgentSession, input: DutyInput) => {
      recorded.duties.push(input)
      const gate = deferred()
      pending.push(gate)
      return gate.promise
    },
    discard: async () => {},
    interrupt: () => {
      const gate = pending[pending.length - 1]
      gate?.reject(new Error("interrupted"))
    },
    sessionLog: async () => "fake session log",
  }

  // Mutable so the bind-timeout tests can pull the adapter out of the
  // registry: a configured lane whose adapter is missing never binds.
  const laneAdapters: DispatcherAdapters = { acp: fakeAcp }

  beforeAll(async () => {
    writeFileSync(join(laneHome, "settings.json"), laneSettings())
    laneApp = buildServer({ store: laneStore, loggerLevel: "error", adapters: laneAdapters })
  })

  afterAll(async () => {
    await laneApp.close()
    rmSync(laneHome, { recursive: true, force: true })
  })

  beforeEach(() => {
    recorded.duties.length = 0
    recorded.seeds.length = 0
    pending.length = 0
  })

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  // 5s: the bind-wait window alone is 2s, so failure-path conditions resolve
  // close to that deadline.
  const waitFor = async (check: () => boolean | Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 5000
    for (;;) {
      if (await check()) return
      if (Date.now() >= deadline) throw new Error("condition not met within 2s")
      await sleep(5)
    }
  }

  const waitForDuty = async (match: (duty: DutyInput) => boolean): Promise<number> => {
    const deadline = Date.now() + 2000
    for (;;) {
      const index = recorded.duties.findIndex(match)
      if (index >= 0) return index
      if (Date.now() >= deadline) throw new Error("duty not recorded within 2s")
      await sleep(5)
    }
  }

  const recordedDuty = (index: number): DutyInput => {
    const duty = recorded.duties[index]
    if (duty === undefined) throw new Error("no duty recorded at index " + String(index))
    return duty
  }

  const resolveDuty = (index: number): void => {
    const gate = pending[index]
    if (gate === undefined) throw new Error("no pending duty at index " + String(index))
    gate.resolve(fakeResult(recordedDuty(index)))
  }

  const rejectDuty = (index: number, error: Error): void => {
    const gate = pending[index]
    if (gate === undefined) throw new Error("no pending duty at index " + String(index))
    gate.reject(error)
  }

  const waitForBound = async (artifactId: string): Promise<void> =>
    waitFor(() => workerRuntime.current?.presence(artifactId).reviewerBound === true)

  const createLaneArtifact = async (
    title: string,
    html: string,
  ): Promise<z.infer<typeof SummarySchema>> => {
    const response = await laneApp.inject({
      method: "POST",
      url: "/api/v1/artifacts",
      payload: { title: title, html: html },
    })
    if (response.statusCode !== 201) throw new Error("lane fixture create failed: " + response.body)
    return SummarySchema.parse(response.json())
  }

  const createLaneThread = async (artifactId: string, body: string): Promise<z.infer<typeof ThreadSchema>> => {
    const response = await laneApp.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + artifactId + "/feedback",
      payload: { body: body },
    })
    expect(response.statusCode).toBe(201)
    return ThreadSchema.parse(response.json())
  }

  const laneView = async (artifactId: string): Promise<z.infer<typeof ViewSchema>> => {
    const response = await laneApp.inject({
      method: "GET",
      url: "/api/v1/artifacts/" + artifactId + "/feedback",
    })
    return ViewSchema.parse(response.json())
  }

  const iterate = async (artifactId: string): Promise<void> => {
    const response = await laneApp.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + artifactId + "/iterations",
      payload: {},
    })
    expect(response.statusCode).toBe(201)
  }

  it("creates and reports lane status", async () => {
    const response = await laneApp.inject({
      method: "POST",
      url: "/api/v1/artifacts",
      payload: {
        title: "Lane create",
        html: "<p>lane-a</p>",
        prompt: "make it pop",
      },
    })
    expect(response.statusCode).toBe(201)
    const summary = SummarySchema.parse(response.json())
    expect(["starting", "idle"]).toContain(summary.reviewer)
    expect(summary.worker).toBe("idle")

    await waitForBound(summary.id)
    const settled = await laneApp.inject({ method: "GET", url: "/api/v1/artifacts/" + summary.id })
    expect(SummarySchema.parse(settled.json()).reviewer).toBe("idle")
    const view = await laneView(summary.id)
    expect(view.reviewerAttached).toBe(true)
    expect(view.workerRunning).toBe(false)
  })

  it("dispatches a reviewer duty on a comment and patches the placeholder with the reply", async () => {
    const created = await createLaneArtifact("Lane reply", "<p>lane-b</p>")
    await waitForBound(created.id)

    const thread = await createLaneThread(created.id, "the hero is huge")
    expect(thread.messages).toHaveLength(2)
    const placeholder = thread.messages[1]
    if (placeholder === undefined) throw new Error("placeholder missing")
    expect(placeholder.kind).toBe("thinking")

    const dutyIndex = await waitForDuty((duty) => duty.lane === "reviewer" && duty.title === "Lane reply")
    const duty = recordedDuty(dutyIndex)
    expect(duty.promptTemplate).toBe(DEFAULT_REVIEWER_PROMPT)
    expect(duty.brief).toBe("")
    expect(duty.version).toBe("v1")
    expect(duty.targets).toEqual([{ threadId: thread.id, messageId: placeholder?.id }])
    expect(duty.threads.map((entry) => entry.id)).toEqual([thread.id])

    resolveDuty(dutyIndex)
    await waitFor(async () => {
      const view = await laneView(created.id)
      const messages = view.threads[0]?.messages ?? []
      return messages[1]?.kind === "text" && messages[1]?.body === "reply:" + (placeholder?.id ?? "")
    })
  })

  it("places and answers a placeholder when the reviewer configures after create", async () => {
    // Restart / late-config scenario: the artifact was created while the
    // reviewer lane was "none", so nothing is bound and no waiter is parked.
    // The first comment must still get a placeholder and a real reply.
    writeFileSync(join(laneHome, "settings.json"), laneSettings({ reviewer: "none" }))
    try {
      const created = await createLaneArtifact("Lane late reviewer", "<p>lane-m</p>")
      expect(workerRuntime.current?.presence(created.id).reviewerBound).toBe(false)

      // Flip the reviewer on after create (settings apply live), then comment.
      writeFileSync(join(laneHome, "settings.json"), laneSettings())
      const thread = await createLaneThread(created.id, "answer me after reconfigure")
      expect(thread.messages).toHaveLength(2)
      expect(thread.messages[1]?.kind).toBe("thinking")

      const dutyIndex = await waitForDuty(
        (duty) => duty.lane === "reviewer" && duty.title === "Lane late reviewer",
      )
      resolveDuty(dutyIndex)
      await waitFor(async () => {
        const view = await laneView(created.id)
        const messages = view.threads[0]?.messages ?? []
        return (
          messages[1]?.kind === "text" &&
          messages[1]?.body === "reply:" + (thread.messages[1]?.id ?? "")
        )
      })
    } finally {
      writeFileSync(join(laneHome, "settings.json"), laneSettings())
    }
  })

  it("dispatches again with a fresh target on a follow-up comment", async () => {
    const created = await createLaneArtifact("Lane followup", "<p>lane-c</p>")
    await waitForBound(created.id)

    const thread = await createLaneThread(created.id, "first comment")
    const firstIndex = await waitForDuty((duty) => duty.lane === "reviewer" && duty.title === "Lane followup")
    resolveDuty(firstIndex)
    await waitFor(async () => (await laneView(created.id)).threads[0]?.messages[1]?.kind === "text")

    const followup = await laneApp.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/threads/" + thread.id + "/messages",
      payload: { body: "also the copy" },
    })
    expect(followup.statusCode).toBe(201)
    const updated = ThreadSchema.parse(followup.json())
    const fresh = updated.messages[updated.messages.length - 1]
    expect(fresh?.kind).toBe("thinking")

    const secondIndex = await waitForDuty(
      (duty) => duty.lane === "reviewer" && duty.targets[0]?.messageId === fresh?.id,
    )
    expect(recordedDuty(secondIndex).threads.map((entry) => entry.id)).toEqual([thread.id])
    resolveDuty(secondIndex)
    await waitFor(async () => {
      const view = await laneView(created.id)
      const messages = view.threads[0]?.messages ?? []
      return messages[messages.length - 1]?.body === "reply:" + (fresh?.id ?? "")
    })
  })

  it("iterates with a worker: dispatches the batch with seed, then publishes the document", async () => {
    const created = await createLaneArtifact("Lane iterate", "<p>lane-d v1</p>")
    await waitForBound(created.id)

    const thread = await createLaneThread(created.id, "add a footer")
    const replyIndex = await waitForDuty((duty) => duty.lane === "reviewer" && duty.title === "Lane iterate")
    resolveDuty(replyIndex)

    await iterate(created.id)
    const workIndex = await waitForDuty((duty) => duty.lane === "worker" && duty.title === "Lane iterate")
    // The worker claims the batch: an agent message lands on the thread.
    const claimed = await laneView(created.id)
    const claimMessages = claimed.threads.find((entry) => entry.id === thread.id)?.messages ?? []
    expect(claimMessages[claimMessages.length - 1]?.author).toBe("agent")
    expect(claimMessages[claimMessages.length - 1]?.body).toBe("Working on this for v2.")
    // While the work duty is parked mid-flight the feedback view reports the
    // running worker and the still-bound reviewer.
    const runningView = await laneView(created.id)
    expect(runningView.reviewerAttached).toBe(true)
    expect(runningView.workerRunning).toBe(true)
    const duty = recordedDuty(workIndex)
    expect(duty.version).toBe("v1")
    expect(duty.batchThreadIds).toEqual([thread.id])
    expect(duty.threads.map((entry) => entry.id)).toEqual([thread.id])
    expect(duty.targets).toEqual([])
    expect(duty.promptTemplate).toBe(DEFAULT_WORKER_PROMPT)
    expect(duty.htmlPath).toBe(join(laneHome, "artifacts", created.id, "v1-index.html"))
    const workerSeed = recorded.seeds.find((seed) => seed !== undefined)
    expect(workerSeed).toEqual({ html: "<p>lane-d v1</p>", version: "v1" })

    resolveDuty(workIndex)
    await waitFor(async () => {
      const view = await laneView(created.id)
      return view.artifactStatus === "review" && view.current === "v2" && view.versions[1]?.note === "redline-note"
    })
    const document = await laneApp.inject({ method: "GET", url: "/a/" + created.id + "/v2/index.html" })
    expect(document.body).toContain("fake next")
    // The worker reports back on the batch thread once the version lands.
    const doneView = await laneView(created.id)
    const doneMessages = doneView.threads.find((entry) => entry.id === thread.id)?.messages ?? []
    expect(doneMessages[doneMessages.length - 1]?.body).toBe("Addressed in v2. redline-note")
  })

  it("skips onDocument when the artifact is no longer iterating", async () => {
    const created = await createLaneArtifact("Lane stale duty", "<p>lane-f v1</p>")
    await waitForBound(created.id)

    await createLaneThread(created.id, "rework it")
    const replyIndex = await waitForDuty((duty) => duty.lane === "reviewer" && duty.title === "Lane stale duty")
    resolveDuty(replyIndex)

    await iterate(created.id)
    const workIndex = await waitForDuty((duty) => duty.lane === "worker" && duty.title === "Lane stale duty")

    // The human path wins while the duty flies: fallback publish, then approve.
    const published = await laneApp.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/versions",
      payload: { html: "<p>lane-f v2</p>", note: "manual" },
    })
    expect(published.statusCode).toBe(201)
    const approved = await laneApp.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/versions/v2/approve",
      payload: {},
    })
    expect(approved.statusCode).toBe(200)

    resolveDuty(workIndex)
    // workerRunning flips false only after onDocument ran, so this proves the skip.
    await waitFor(() => workerRuntime.current?.presence(created.id).workerRunning === false)
    const view = await laneView(created.id)
    expect(view.current).toBe("v2")
    expect(view.versions).toHaveLength(2)
  })

  it("approve unbinds the lanes", async () => {
    const created = await createLaneArtifact("Lane approve", "<p>lane-g v1</p>")
    await waitForBound(created.id)

    await createLaneThread(created.id, "polish")
    const replyIndex = await waitForDuty((duty) => duty.lane === "reviewer" && duty.title === "Lane approve")
    resolveDuty(replyIndex)

    await iterate(created.id)
    const workIndex = await waitForDuty((duty) => duty.lane === "worker" && duty.title === "Lane approve")
    resolveDuty(workIndex)
    await waitFor(async () => (await laneView(created.id)).current === "v2")

    expect(workerRuntime.current?.presence(created.id).reviewerBound).toBe(true)
    expect(workerRuntime.current?.presence(created.id).workerBound).toBe(true)

    const approved = await laneApp.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/versions/v2/approve",
      payload: {},
    })
    expect(approved.statusCode).toBe(200)
    await waitFor(
      () =>
        workerRuntime.current?.presence(created.id).reviewerBound === false &&
        workerRuntime.current?.presence(created.id).workerBound === false,
    )
  })

  it("marks placeholders unavailable when the reviewer lane fails", async () => {
    const created = await createLaneArtifact("Lane failure", "<p>lane-i</p>")
    await waitForBound(created.id)

    await createLaneThread(created.id, "this will fail")
    const dutyIndex = await waitForDuty((duty) => duty.lane === "reviewer" && duty.title === "Lane failure")
    rejectDuty(dutyIndex, new Error("agent exploded"))

    await waitFor(async () => {
      const view = await laneView(created.id)
      return view.threads[0]?.messages[1]?.body === "reviewer unavailable: agent exploded"
    })
    expect(workerRuntime.current?.presence(created.id).reviewerBound).toBe(false)
  })

  it("rolls a failed worker round back to review with threads intact", async () => {
    const created = await createLaneArtifact("Lane worker fail", "<p>lane-n v1</p>")
    await waitForBound(created.id)

    await createLaneThread(created.id, "do the thing")
    const replyIndex = await waitForDuty((duty) => duty.lane === "reviewer" && duty.title === "Lane worker fail")
    resolveDuty(replyIndex)

    await iterate(created.id)
    const workIndex = await waitForDuty((duty) => duty.lane === "worker" && duty.title === "Lane worker fail")
    rejectDuty(workIndex, new Error("boom"))

    await waitFor(async () => {
      const view = await laneView(created.id)
      const messages = view.threads[0]?.messages ?? []
      return (
        messages[messages.length - 1]?.body ===
        "Iteration failed: boom — threads stay open; Iterate again when ready."
      )
    })
    const view = await laneView(created.id)
    expect(view.artifactStatus).toBe("review")
    expect(view.versions.some((version: { batch?: unknown; publishedAt?: unknown }) => version.batch !== undefined && version.publishedAt === undefined)).toBe(false)
    expect(view.threads.every((thread: { status: string }) => thread.status === "open")).toBe(true)
  })

  it("stamps the live worker session and serves its log while iterating", async () => {
    const created = await createLaneArtifact("Lane log", "<p>lane-o v1</p>")
    await waitForBound(created.id)

    await createLaneThread(created.id, "make it better")
    const replyIndex = await waitForDuty((duty) => duty.lane === "reviewer" && duty.title === "Lane log")
    resolveDuty(replyIndex)

    await iterate(created.id)
    await waitForDuty((duty) => duty.lane === "worker" && duty.title === "Lane log")

    const logResponse = await laneApp.inject({
      method: "GET",
      url: "/api/v1/artifacts/" + created.id + "/iterations/current/log",
    })
    expect(logResponse.statusCode).toBe(200)
    expect(logResponse.json()).toMatchObject({
      running: true,
      adapterId: "acp",
      sessionId: "fake-1",
      log: "fake session log",
    })
    const view = await laneView(created.id)
    expect(view.workerLive).toBe(true)

    resolveDuty(await waitForDuty((duty) => duty.lane === "worker" && duty.title === "Lane log"))
    await waitFor(async () => (await laneView(created.id)).current === "v2")
    const ended = await laneApp.inject({
      method: "GET",
      url: "/api/v1/artifacts/" + created.id + "/iterations/current/log",
    })
    expect(ended.json()).toMatchObject({ running: false, log: "" })
  })

  it("stops a running round: rollback, interrupt, threads intact", async () => {
    const created = await createLaneArtifact("Lane stop", "<p>lane-p v1</p>")
    await waitForBound(created.id)

    await createLaneThread(created.id, "stop me")
    const replyIndex = await waitForDuty((duty) => duty.lane === "reviewer" && duty.title === "Lane stop")
    resolveDuty(replyIndex)

    await iterate(created.id)
    const workIndex = await waitForDuty((duty) => duty.lane === "worker" && duty.title === "Lane stop")

    const stopped = await laneApp.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/iterations/current/stop",
      payload: {},
    })
    expect(stopped.statusCode).toBe(200)
    expect(stopped.json()).toMatchObject({ status: "review", current: "v1", stoppedVersion: "v2" })

    const view = await laneView(created.id)
    expect(view.artifactStatus).toBe("review")
    expect(view.versions).toHaveLength(1)
    expect(
      view.threads[0]?.messages.some(
        (message: { body: string }) => message.body === "Iteration stopped — threads stay open.",
      ),
    ).toBe(true)

    // The interrupted duty settles through the error path with nothing left
    // to heal, and the lane returns to idle.
    await waitFor(() => workerRuntime.current?.presence(created.id).workerRunning === false)
    expect((await laneView(created.id)).artifactStatus).toBe("review")

    // A fresh iterate works and reuses the version number.
    const dutiesBefore = recorded.duties.length
    await iterate(created.id)
    const secondIndex = await waitForDuty(
      (duty) => duty.lane === "worker" && recorded.duties.indexOf(duty) >= dutiesBefore,
    )
    resolveDuty(secondIndex)
    await waitFor(async () => (await laneView(created.id)).current === "v2")
    expect(workIndex).toBeGreaterThanOrEqual(0)
  })

  it("stops an orphaned round left iterating without a duty", async () => {
    const created = await createLaneArtifact("Lane orphan", "<p>lane-q v1</p>")
    await waitForBound(created.id)

    await createLaneThread(created.id, "orphan me")
    // Simulate a server restart mid-round: iterate in the store with no
    // dispatch, so nothing is running while the status says iterating.
    await startIteration(laneStore, created.id)

    const stopped = await laneApp.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/iterations/current/stop",
      payload: {},
    })
    expect(stopped.statusCode).toBe(200)
    expect(stopped.json()).toMatchObject({ status: "review", stoppedVersion: "v2" })
    const view = await laneView(created.id)
    expect(view.versions).toHaveLength(1)
    expect(
      view.threads[0]?.messages.some(
        (message: { body: string }) =>
          message.body === "Iteration stopped (worker was not running) — threads stay open.",
      ),
    ).toBe(true)
  })

  it("rejects stopping an artifact that is not iterating", async () => {
    const created = await createLaneArtifact("Lane stop conflict", "<p>lane-r</p>")
    const stopped = await laneApp.inject({
      method: "POST",
      url: "/api/v1/artifacts/" + created.id + "/iterations/current/stop",
      payload: {},
    })
    expect(stopped.statusCode).toBe(409)
  })

  it("reports the worker debug view for configured lanes", async () => {
    const created = await createLaneArtifact("Lane debug", "<p>lane-j</p>")
    await waitForBound(created.id)

    const response = await laneApp.inject({ method: "GET", url: "/api/v1/artifacts/" + created.id + "/worker" })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      artifactId: created.id,
      attached: true,
      reviewer: { adapter: "acp", bound: true },
      worker: { adapter: "acp", running: false, bound: false },
    })
  })

  it("patches outstanding placeholders when the reviewer bind never lands", async () => {
    // Pull the adapter from the registry: attach never binds, so a
    // comment's dispatch waits out the bind window and must fail the lane
    // instead of leaving the placeholder dangling.
    delete laneAdapters.acp
    try {
      const created = await createLaneArtifact("Lane bind timeout", "<p>lane-k</p>")
      expect(workerRuntime.current?.presence(created.id).reviewerBound).toBe(false)

      const after = new Date(Date.now() + 80).toISOString()
      const poller = laneApp.inject({
        method: "GET",
        url: "/api/v1/artifacts/" + created.id + "/feedback?wait=30&after=" + encodeURIComponent(after),
      })
      await sleep(300)
      // The waiting long-poll counts as attached, so the comment gets a
      // placeholder even though the reviewer lane will never bind.
      const thread = await createLaneThread(created.id, "nobody will answer")
      expect(thread.messages).toHaveLength(2)
      expect(thread.messages[1]?.kind).toBe("thinking")

      // The comment itself wakes the poller, so wait on the patch directly;
      // the bind window (2s) must expire and fail the lane.
      await waitFor(async () => {
        const view = await laneView(created.id)
        return view.threads[0]?.messages[1]?.body === "reviewer unavailable: reviewer lane failed to start"
      })
      await poller
    } finally {
      laneAdapters.acp = fakeAcp
    }
  })

  it("answers the iterate route with a distinct message when the worker lane fails to start", async () => {
    // Worker adapter absent from the registry: the bind window expires
    // and the route fails the lane with its own conflict copy.
    delete laneAdapters.acp
    try {
      const created = await createLaneArtifact("Lane iterate fail", "<p>lane-l</p>")
      await createLaneThread(created.id, "will not dispatch")

      const response = await laneApp.inject({
        method: "POST",
        url: "/api/v1/artifacts/" + created.id + "/iterations",
        payload: {},
      })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ status: 409, detail: "worker lane failed to start" })
    } finally {
      laneAdapters.acp = fakeAcp
    }
  })
})
