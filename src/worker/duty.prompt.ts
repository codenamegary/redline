import { stat } from "node:fs/promises"

import { z } from "zod"

import { Thread, ThreadMessage } from "../store/artifact.models"
import { DutyInput, DutyResult, SeedSpec, ThreadRef } from "./host.adapter"

export type TemplateVars = {
  title: string
  version: string
  brief: string
  threads: Thread[]
  batch: string[]
}

const renderAnchor = (thread: Thread): string => {
  const anchor = thread.anchor
  if (anchor === null) return ""
  const text = anchor.text.length > 0 ? ' ("' + anchor.text + '")' : ""
  return " — anchor " + anchor.selector + text
}

// Thinking placeholders carry their ids: the reviewer needs threadId and
// messageId to target replies in the machine contract below.
const renderMessage = (threadId: string, message: ThreadMessage): string => {
  if (message.kind === "thinking") {
    return (
      "  agent: … (thinking — awaiting reply; threadId " + threadId + ", messageId " + message.id + ")"
    )
  }
  return "  " + message.author + ": " + message.body
}

export const renderThreads = (threads: Thread[]): string =>
  threads
    .map((thread) => {
      const head = "thread " + thread.id + " (" + thread.status + ")" + renderAnchor(thread)
      const body = thread.messages.map((message) => renderMessage(thread.id, message)).join("\n")
      return head + "\n" + body
    })
    .join("\n\n")

// Batch rendering: the frozen ids plus the same thread detail, filtered to
// the batch the worker must address.
export const renderBatch = (batchThreadIds: string[], threads: Thread[]): string => {
  const ids = batchThreadIds.length > 0 ? batchThreadIds.join(", ") : "(none)"
  const inBatch = threads.filter((thread) => batchThreadIds.includes(thread.id))
  const detail = renderThreads(inBatch)
  return "Batch thread ids: " + ids + (detail.length > 0 ? "\n\n" + detail : "")
}

export const renderTemplate = (template: string, vars: TemplateVars): string =>
  template
    .replaceAll("{{title}}", vars.title)
    .replaceAll("{{version}}", vars.version)
    .replaceAll("{{brief}}", vars.brief)
    .replaceAll("{{threads}}", renderThreads(vars.threads))
    .replaceAll("{{batch}}", renderBatch(vars.batch, vars.threads))

const replyContract = (targets: ThreadRef[]): string => {
  const list =
    targets.length > 0
      ? "\nFill exactly these placeholders: " +
        targets.map((target) => target.threadId + "/" + target.messageId).join(", ") +
        "."
      : ""
  return (
    "\n\nOutput contract (a machine parses your reply):\n" +
    "Your ENTIRE output must be exactly one JSON array, nothing else. " +
    "One object per thinking placeholder you are replying to:\n" +
    '[{"threadId":"<thread id>","messageId":"<message id>","body":"<reply text>"}]\n' +
    "Use the threadId and messageId values from the placeholder lines." +
    list +
    "\nNo markdown fences. No prose before or after the array."
  )
}

export const buildReplyPrompt = (input: DutyInput): string =>
  renderTemplate(input.promptTemplate, {
    title: input.title,
    version: input.version,
    brief: input.brief,
    threads: input.threads,
    batch: [],
  }) + replyContract(input.targets)

const workContract = [
  "",
  "",
  "Output contract (a machine parses your document):",
  "Return ONE complete single-file HTML document.",
  "The document MUST begin with this exact line:",
  "<!-- redline-note: <one-sentence what changed> -->",
  "No markdown fences. No prose before the document or after </html>.",
].join("\n")

export const buildWorkPrompt = (input: DutyInput): string =>
  renderTemplate(input.promptTemplate, {
    title: input.title,
    version: input.version,
    brief: input.brief,
    threads: input.threads,
    batch: input.batchThreadIds ?? [],
  }) + workContract

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// First duty on a worker lane carries the document. A htmlPath that exists
// on disk is passed as a pointer (never inlined); otherwise the seed html
// ships inline. Reviewer lanes never get HTML. Callers own the once-per-
// session tracking via their seeded flag.
export const buildSeedContext = async (input: DutyInput, seed?: SeedSpec): Promise<string> => {
  if (seed === undefined || input.lane !== "worker") return ""
  if (input.htmlPath !== undefined && (await fileExists(input.htmlPath))) {
    return "The current document is on disk at " + input.htmlPath + ". Read it first."
  }
  return "Current document (v" + seed.version + "):\n\n```html\n" + seed.html + "\n```"
}

const ReplyItemsSchema = z.array(
  z.object({
    threadId: z.string(),
    messageId: z.string(),
    body: z.string(),
  }),
)

export const parseReplyResult = (raw: string): DutyResult => {
  try {
    const start = raw.indexOf("[")
    const end = raw.lastIndexOf("]")
    if (start < 0 || end <= start) throw new Error("no JSON array in output")
    const items = ReplyItemsSchema.parse(JSON.parse(raw.slice(start, end + 1)))
    return { kind: "replies", items }
  } catch {
    throw new Error("reviewer returned unparseable output")
  }
}

const lastMatchIndex = (raw: string, pattern: RegExp): number => {
  let last = -1
  for (const match of raw.matchAll(pattern)) {
    if (match.index !== undefined) last = match.index
  }
  return last
}

export const parseWorkResult = (raw: string): DutyResult => {
  // The contract asks for a leading redline-note comment; it may sit before
  // the doctype, so search the prefix ahead of <html> for it and strip it
  // before cutting the document bounds.
  const htmlOpen = /<html/i.exec(raw)
  const prefixEnd = htmlOpen !== null && htmlOpen.index !== undefined ? htmlOpen.index : raw.length
  const noteMatch = /<!--\s*redline-note:\s*([\s\S]*?)-->/i.exec(raw.slice(0, prefixEnd))
  const note = noteMatch !== null && noteMatch[1] !== undefined ? noteMatch[1].trim() : ""
  const stripped =
    noteMatch !== null && noteMatch.index !== undefined
      ? raw.slice(0, noteMatch.index) + raw.slice(noteMatch.index + noteMatch[0].length)
      : raw
  const docOpen = /<!doctype html|<html/i.exec(stripped)
  if (docOpen === null || docOpen.index === undefined) {
    throw new Error("worker returned no HTML document")
  }
  const start = docOpen.index
  const close = lastMatchIndex(stripped, /<\/html>/gi)
  const html = close > start ? stripped.slice(start, close + "</html>".length) : stripped.slice(start)
  return { kind: "document", html: html.trimStart(), note }
}
