import { describe, expect, it } from "bun:test"

import { Thread } from "@redline/http-contracts/artifact.models"
import { DEFAULT_REVIEWER_PROMPT, DEFAULT_WORKER_PROMPT } from "./prompts"
import {
  buildLanePrompt,
  buildSeedContext,
  buildReplyPrompt,
  buildWorkPrompt,
  parseLaneResult,
  parseReplyResult,
  parseWorkResult,
  renderTemplate,
} from "./duty.prompt"
import { DutyInput, SeedSpec } from "./host.adapter"

const iso = "2026-01-01T00:00:00.000Z"

const threadFixture = (overrides?: Partial<Thread>): Thread => ({
  id: "t1",
  status: "open",
  anchor: { selector: ".cta", text: "Buy now" },
  messages: [
    { id: "m1", author: "user", kind: "text", body: "The button overlaps the footer", createdAt: iso },
    { id: "m2", author: "agent", kind: "thinking", body: "…", createdAt: iso },
  ],
  createdAt: iso,
  ...overrides,
})

const reviewerInput = (overrides?: Partial<DutyInput>): DutyInput => ({
  lane: "reviewer",
  promptTemplate: DEFAULT_REVIEWER_PROMPT,
  brief: "landing page for a coffee brand",
  title: "Landing page",
  version: "v1",
  threads: [threadFixture()],
  targets: [{ threadId: "t1", messageId: "m2" }],
  ...overrides,
})

const workerInput = (overrides?: Partial<DutyInput>): DutyInput => ({
  lane: "worker",
  promptTemplate: DEFAULT_WORKER_PROMPT,
  brief: "landing page for a coffee brand",
  title: "Landing page",
  version: "v2",
  threads: [threadFixture()],
  targets: [],
  batchThreadIds: ["t1"],
  ...overrides,
})

describe("renderTemplate", () => {
  it("substitutes every placeholder", () => {
    const rendered = renderTemplate("{{title}} {{version}} {{brief}}", {
      title: "Landing page",
      version: "v1",
      brief: "a page",
      threads: [],
      batch: [],
    })
    expect(rendered).toBe("Landing page v1 a page")
  })

  it("renders threads with anchors, message lines, and placeholder ids", () => {
    const rendered = renderTemplate("{{threads}}", {
      title: "t",
      version: "v1",
      brief: "b",
      threads: [threadFixture()],
      batch: [],
    })
    expect(rendered).toContain('thread t1 (open) — anchor .cta ("Buy now")')
    expect(rendered).toContain("  user: The button overlaps the footer")
    expect(rendered).toContain("threadId t1, messageId m2")
    expect(rendered).not.toContain("<html")
  })

  it("renders batch as ids plus the batch-filtered thread detail", () => {
    const rendered = renderTemplate("{{batch}}", {
      title: "t",
      version: "v1",
      brief: "b",
      threads: [threadFixture(), threadFixture({ id: "t2", messages: [threadFixture().messages[0]!] })],
      batch: ["t1"],
    })
    expect(rendered).toContain("Batch thread ids: t1")
    expect(rendered).toContain("thread t1 (open)")
    expect(rendered).not.toContain("thread t2")
  })

  it("renders an empty batch as (none)", () => {
    const rendered = renderTemplate("{{batch}}", {
      title: "t",
      version: "v1",
      brief: "b",
      threads: [],
      batch: [],
    })
    expect(rendered).toContain("Batch thread ids: (none)")
  })
})

describe("buildReplyPrompt", () => {
  it("renders the template and appends the JSON-array contract", () => {
    const prompt = buildReplyPrompt(reviewerInput())
    expect(prompt).toContain('You are the redline reviewer for "Landing page" (v1)')
    expect(prompt).toContain("The button overlaps the footer")
    expect(prompt).toContain("threadId t1, messageId m2")
    expect(prompt).toContain("Your ENTIRE output must be exactly one JSON array")
    expect(prompt).toContain('[{"threadId":"<thread id>","messageId":"<message id>","body":"<reply text>"}]')
    expect(prompt).toContain("Fill exactly these placeholders: t1/m2")
    // Reviewer prompts never carry HTML.
    expect(prompt).not.toContain("<html")
    expect(prompt).not.toContain("```html")
  })
})

describe("buildWorkPrompt", () => {
  it("renders the template and appends the document contract", () => {
    const prompt = buildWorkPrompt(workerInput())
    expect(prompt).toContain('You are revising "Landing page" to the next version')
    expect(prompt).toContain("Batch thread ids: t1")
    expect(prompt).toContain("<!-- redline-note: <one-sentence what changed> -->")
    expect(prompt).toContain("No markdown fences.")
  })

  it("appends read-only repo context when the duty carries a cwd", () => {
    const prompt = buildWorkPrompt(workerInput({ cwd: "/repo/coffee-site" }))
    expect(prompt).toContain("Repo context:")
    expect(prompt).toContain("lives at /repo/coffee-site")
    expect(prompt).toContain("You may read project files there")
    expect(prompt).toContain("Read-only: never modify, create, or delete files in the project.")
    // Repo context precedes the output contract.
    expect(prompt.indexOf("Repo context:")).toBeLessThan(prompt.indexOf("Output contract"))
  })

  it("omits repo context without a cwd and never on reviewer lanes", () => {
    expect(buildWorkPrompt(workerInput())).not.toContain("Repo context:")
    expect(buildReplyPrompt(reviewerInput({ cwd: "/repo/coffee-site" }))).not.toContain("Repo context:")
  })
})

describe("buildLanePrompt", () => {
  it("picks the contract by lane and parseLaneResult reads it back", () => {
    const replyPrompt = buildLanePrompt(reviewerInput())
    expect(replyPrompt).toContain("Your ENTIRE output must be exactly one JSON array")
    const workPrompt = buildLanePrompt(workerInput())
    expect(workPrompt).toContain("Output contract (a machine parses your document)")

    const replies = parseLaneResult("reviewer", '[{"threadId":"t1","messageId":"m2","body":"ok"}]')
    expect(replies).toEqual({
      kind: "replies",
      items: [{ threadId: "t1", messageId: "m2", body: "ok" }],
    })
    const doc = parseLaneResult("worker", "<html><body>x</body></html>")
    expect(doc).toEqual({ kind: "document", html: "<html><body>x</body></html>", note: "" })
  })
})

describe("buildSeedContext", () => {
  it("always inlines the document with an intro line, no fences and no disk pointer", () => {
    const seed: SeedSpec = { html: "<html><body>v1</body></html>", version: "v1" }
    const context = buildSeedContext(workerInput({ htmlPath: "/tmp/a/v1/index.html" }), seed)
    expect(context).toBe(
      "Current document (v1), complete single-file HTML:\n\n<html><body>v1</body></html>",
    )
    expect(context).not.toContain("```")
    expect(context).not.toContain("on disk")
    expect(context).not.toContain("htmlPath")
  })

  it("returns empty for reviewer lanes, missing seeds, and empty seeds", () => {
    const seed: SeedSpec = { html: "<p>x</p>", version: "v1" }
    expect(buildSeedContext(reviewerInput(), seed)).toBe("")
    expect(buildSeedContext(workerInput())).toBe("")
    // Empty seed: the file was unreadable when the route enqueued the duty.
    expect(buildSeedContext(workerInput(), { html: "", version: "v1" })).toBe("")
  })
})

describe("parseReplyResult", () => {
  it("parses a bare array", () => {
    const result = parseReplyResult('[{"threadId":"t1","messageId":"m2","body":"on it"}]')
    expect(result).toEqual({
      kind: "replies",
      items: [{ threadId: "t1", messageId: "m2", body: "on it" }],
    })
  })

  it("tolerates fences and prose around the array", () => {
    const raw =
      'Here you go:\n```json\n[{"threadId":"t1","messageId":"m2","body":"ok"}]\n```\nDone.'
    const result = parseReplyResult(raw)
    expect(result.kind === "replies" && result.items[0]?.body).toBe("ok")
  })

  it("throws on unparseable output", () => {
    expect(() => parseReplyResult("no array here")).toThrow(
      "reviewer returned unparseable output",
    )
    expect(() => parseReplyResult('[{"threadId":1,"messageId":"m","body":"b"}]')).toThrow(
      "reviewer returned unparseable output",
    )
  })
})

describe("parseWorkResult", () => {
  it("extracts the document and strips a leading note comment", () => {
    const raw =
      'Junk before\n<!doctype html>\n<!-- redline-note: moved the footer -->\n<html><body>hi</body></html>\ntrailing junk'
    const result = parseWorkResult(raw)
    expect(result).toEqual({
      kind: "document",
      html: "<!doctype html>\n\n<html><body>hi</body></html>",
      note: "moved the footer",
    })
  })

  it("accepts a note placed after the doctype and defaults to an empty note", () => {
    const result = parseWorkResult("<!doctype html>\n<html><body>hi</body></html>")
    expect(result).toEqual({ kind: "document", html: "<!doctype html>\n<html><body>hi</body></html>", note: "" })
  })

  it("is case-insensitive on the doctype", () => {
    const result = parseWorkResult("<!DOCTYPE HTML><html><body>x</body></html>")
    expect(result.kind === "document" && result.html.startsWith("<!DOCTYPE HTML>")).toBe(true)
  })

  it("extracts from <html when the doctype is missing", () => {
    const result = parseWorkResult("prose\n<html><body>x</body></html>\nmore")
    expect(result.kind === "document" && result.html).toBe("<html><body>x</body></html>")
  })

  it("throws when there is no HTML document at all", () => {
    expect(() => parseWorkResult("just words, sorry")).toThrow("worker returned no HTML document")
  })
})

describe("DEFAULT_WORKER_PROMPT truncation defense", () => {
  it("declares the output-stream contract the server implements", () => {
    expect(DEFAULT_WORKER_PROMPT).toContain("Your deliverable is your output stream")
  })

  it("requires exactly one document in the stream", () => {
    expect(DEFAULT_WORKER_PROMPT).toContain("exactly one <!doctype html>")
    expect(DEFAULT_WORKER_PROMPT).toContain("one </html>")
  })

  it("forbids a second copy or a restart from the top", () => {
    expect(DEFAULT_WORKER_PROMPT).toContain("Never emit a second copy of it")
    expect(DEFAULT_WORKER_PROMPT).toContain("Never restart it from the top")
  })

  it("keeps narration out of the document stream", () => {
    expect(DEFAULT_WORKER_PROMPT).toContain("No narration")
  })

  it("continues at the cut point instead of restarting after a truncated reply", () => {
    expect(DEFAULT_WORKER_PROMPT).toContain(
      "Continue the document in your next reply at the exact character where the cut happened",
    )
    expect(DEFAULT_WORKER_PROMPT).toContain("Mid-tag is fine")
    expect(DEFAULT_WORKER_PROMPT).toContain("No new <!doctype html>")
  })

  it("explains why a restart can never finish", () => {
    expect(DEFAULT_WORKER_PROMPT).toContain("truncates again at the same depth")
  })

  it("keeps the template placeholder contract intact", () => {
    expect(DEFAULT_WORKER_PROMPT).toContain("{{title}}")
    expect(DEFAULT_WORKER_PROMPT).toContain("{{brief}}")
    expect(DEFAULT_WORKER_PROMPT).toContain("{{batch}}")
  })

  it("still renders through buildWorkPrompt alongside the machine contract", () => {
    const prompt = buildWorkPrompt(workerInput())
    expect(prompt).toContain("exactly one <!doctype html>")
    expect(prompt).toContain("<!-- redline-note: <one-sentence what changed> -->")
    expect(prompt).toContain("No markdown fences.")
  })
})
