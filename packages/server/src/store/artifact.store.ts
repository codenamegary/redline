import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  Anchor,
  ArtifactMeta,
  ArtifactMetaSchema,
  ArtifactVersion,
  Author,
  FeedbackDoc,
  FeedbackDocSchema,
  MessageKind,
  OriginRef,
  Thread,
  ThreadMessage,
  ThreadStatus,
  VersionSchema,
  pendingVersion,
} from "@redline/http-contracts/artifact.models"
import { FeedbackView } from "@redline/http-contracts/artifact.schemas"
import { hasErrorCode, storeError } from "./errors"

export type Store = {
  home: string
  artifactsDir: string
}

const epochTimestamp = "1970-01-01T00:00:00.000Z"

export const openStore = (home: string): Store => {
  mkdirSync(home, { recursive: true })
  const artifactsDir = join(home, "artifacts")
  mkdirSync(artifactsDir, { recursive: true })
  return { home, artifactsDir }
}

const fileLocks = new Map<string, Promise<unknown>>()

const withFileLock = <T>(key: string, task: () => Promise<T>): Promise<T> => {
  const previous = fileLocks.get(key) ?? Promise.resolve()
  const result = previous.then(task, task)
  fileLocks.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  )
  return result
}

export const artifactDir = (store: Store, id: string): string => join(store.artifactsDir, id)

export const artifactMetaPath = (store: Store, id: string): string =>
  join(artifactDir(store, id), "meta.json")

export const artifactVersionFile = (store: Store, id: string, version: string): string =>
  join(artifactDir(store, id), version + "-index.html")

// Per-version static assets (generated images and the like) live in a
// sibling directory next to the flat version file: <id>/v<N>-assets/<name>.
export const artifactVersionAssetsDir = (store: Store, id: string, version: string): string =>
  join(artifactDir(store, id), version + "-assets")

export const artifactVersionAssetFile = (store: Store, id: string, version: string, filename: string): string =>
  join(artifactVersionAssetsDir(store, id, version), filename)

export const assetExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"] as const

// Single path segment, no separators, no leading dot: the pattern alone
// kills traversal, spaces, and hidden files. Reused by the static handler,
// so serving and saving share one definition of a legal asset name.
const assetNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/

export const maxAssetBytes = 5_000_000

export const isValidAssetName = (filename: string): boolean => {
  const dot = filename.lastIndexOf(".")
  const ext = dot === -1 ? "" : filename.slice(dot).toLowerCase()
  return assetNamePattern.test(filename) && (assetExtensions as readonly string[]).includes(ext)
}

// Validate a requested asset filename or throw not-found. The static
// handler routes /a/:id/:version/<name> through here, so a bad name can
// never resolve to a file outside the version assets dir.
export const assetFilename = (filename: string): string => {
  if (!isValidAssetName(filename)) throw storeError("not-found", "asset not found")
  return filename
}

export const saveVersionAsset = async (
  store: Store,
  id: string,
  version: string,
  filename: string,
  bytes: Uint8Array,
): Promise<{ filename: string; assets: string[] }> =>
  withFileLock(artifactMetaPath(store, id), async () => {
    if (!isValidAssetName(filename)) {
      throw storeError("unprocessable", "invalid asset filename: letters, digits, dot, dash, underscore, known image extension")
    }
    const name = filename
    if (bytes.byteLength === 0) throw storeError("unprocessable", "asset is empty")
    if (bytes.byteLength > maxAssetBytes) {
      throw storeError("unprocessable", "asset exceeds " + String(maxAssetBytes) + " bytes")
    }
    const meta = await readArtifactMeta(store, id)
    const row = meta.versions.find((entry) => entry.version === version)
    if (row === undefined) throw storeError("not-found", "version not found: " + version)
    const assetsDir = artifactVersionAssetsDir(store, id, version)
    const target = join(assetsDir, name)
    if (existsSync(target)) {
      throw storeError("conflict", "asset already exists: " + name + " (pick a new filename)")
    }
    await mkdir(assetsDir, { recursive: true })
    await writeFile(target, bytes)
    const assets = [...(row.assets ?? []), name].sort((a, b) => a.localeCompare(b))
    await writeArtifactMeta(store, id, {
      ...meta,
      updatedAt: new Date().toISOString(),
      versions: meta.versions.map((entry) => (entry.version === version ? { ...entry, assets } : entry)),
    })
    return { filename: name, assets }
  })

export const listVersionAssets = async (store: Store, id: string, version: string): Promise<string[]> => {
  const dir = artifactVersionAssetsDir(store, id, version)
  const entries = await readdir(dir).catch(() => [])
  return entries.sort((a, b) => a.localeCompare(b))
}

const feedbackDocPath = (store: Store, id: string, version: string): string =>
  join(artifactDir(store, id), version + "-feedback.json")

const pad2 = (value: number): string => String(value).padStart(2, "0")

const utcTimestampPart = (at: Date): string =>
  at.getUTCFullYear() +
  "-" +
  pad2(at.getUTCMonth() + 1) +
  "-" +
  pad2(at.getUTCDate()) +
  "-" +
  pad2(at.getUTCHours()) +
  pad2(at.getUTCMinutes()) +
  pad2(at.getUTCSeconds())

const slugify = (title: string): string => {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "")
  return slug.length > 0 ? slug : "artifact"
}

const uniqueArtifactId = (store: Store, base: string, attempt = 1): string => {
  const candidate = attempt === 1 ? base : base + "-" + String(attempt)
  return existsSync(join(store.artifactsDir, candidate)) ? uniqueArtifactId(store, base, attempt + 1) : candidate
}

const newId = (prefix: string): string => prefix + "-" + randomUUID().replaceAll("-", "").slice(0, 10)

const readRawMeta = async (store: Store, id: string): Promise<string> => {
  try {
    return await readFile(artifactMetaPath(store, id), "utf8")
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) throw storeError("not-found", "artifact not found: " + id)
    throw error
  }
}

export const readArtifactMeta = async (store: Store, id: string): Promise<ArtifactMeta> =>
  ArtifactMetaSchema.parse(JSON.parse(await readRawMeta(store, id)))

const writeArtifactMeta = async (store: Store, id: string, meta: ArtifactMeta): Promise<void> => {
  await mkdir(artifactDir(store, id), { recursive: true })
  await writeFile(artifactMetaPath(store, id), JSON.stringify(meta, null, 2) + "\n", "utf8")
}

export type CreateArtifactInput = {
  title: string
  prompt: string
  html: string
  note?: string
  origin?: OriginRef
}

export const createArtifact = async (store: Store, input: CreateArtifactInput): Promise<ArtifactMeta> => {
  const now = new Date().toISOString()
  const id = uniqueArtifactId(store, utcTimestampPart(new Date()) + "-" + slugify(input.title))
  const meta: ArtifactMeta = {
    id: id,
    title: input.title,
    prompt: input.prompt,
    status: "review",
    createdAt: now,
    updatedAt: now,
    current: "v1",
    versions: [{ version: VersionSchema.parse("v1"), createdAt: now, publishedAt: now, note: input.note }],
    origin: input.origin,
  }
  await mkdir(artifactDir(store, id), { recursive: true })
  await writeFile(artifactVersionFile(store, id, "v1"), input.html, "utf8")
  await writeArtifactMeta(store, id, meta)
  return meta
}

export type PublishInput = {
  html: string
  note?: string
}

// Publish the pending iteration: write the html, complete the version row,
// and flip the artifact back to review. Only legal while iterating — this is
// the server-side gate that keeps live comment replies consequence-free.
export const publishIteration = async (store: Store, id: string, input: PublishInput): Promise<ArtifactMeta> =>
  withFileLock(artifactMetaPath(store, id), async () => {
    const meta = await readArtifactMeta(store, id)
    if (meta.status !== "iterating") {
      throw storeError(
        "conflict",
        "publishing requires status=iterating; comments wake the agent for replies only",
      )
    }
    const pending = pendingVersion(meta)
    if (pending === undefined) throw storeError("conflict", "no pending iteration to publish")
    const now = new Date().toISOString()
    const file = artifactVersionFile(store, id, pending.version)
    await mkdir(artifactDir(store, id), { recursive: true })
    await writeFile(file, input.html, "utf8")
    const updated: ArtifactMeta = {
      ...meta,
      status: "review",
      updatedAt: now,
      current: pending.version,
      versions: meta.versions.map((version) =>
        version.version === pending.version
          ? { ...version, note: input.note, publishedAt: now }
          : version,
      ),
    }
    await writeArtifactMeta(store, id, updated)
    return updated
  })

const openThreadIds = async (store: Store, id: string): Promise<string[]> => {
  const docs = await readAllFeedbackDocs(store, id)
  return docs.flatMap((doc) => doc.threads.filter((thread) => thread.status === "open").map((thread) => thread.id))
}

// Freeze the open threads into a pending version row and flip review ->
// iterating. The batch is the agent's work contract for this version.
export const startIteration = async (
  store: Store,
  id: string,
): Promise<{ meta: ArtifactMeta; version: ArtifactVersion }> =>
  withFileLock(artifactMetaPath(store, id), async () => {
    const meta = await readArtifactMeta(store, id)
    if (meta.status !== "review") {
      throw storeError("conflict", "iteration requires status=review, got " + meta.status)
    }
    if (pendingVersion(meta) !== undefined) {
      throw storeError("conflict", "an iteration is already pending")
    }
    const now = new Date().toISOString()
    const version: ArtifactVersion = {
      version: VersionSchema.parse("v" + String(meta.versions.length + 1)),
      createdAt: now,
      batch: { threadIds: await openThreadIds(store, id), submittedAt: now },
    }
    const updated: ArtifactMeta = {
      ...meta,
      status: "iterating",
      iteratedAt: now,
      updatedAt: now,
      versions: [...meta.versions, version],
    }
    await writeArtifactMeta(store, id, updated)
    return { meta: updated, version: version }
  })

// Stamp the current version approved. Approval is data, not a loop state:
// the artifact stays in review and can always be iterated again.
export const approveVersion = async (store: Store, id: string, version: string): Promise<ArtifactVersion> =>
  withFileLock(artifactMetaPath(store, id), async () => {
    const meta = await readArtifactMeta(store, id)
    if (meta.status === "iterating") {
      throw storeError("conflict", "finish the iterating round before approving")
    }
    if (version !== meta.current) {
      throw storeError("not-found", "only the current version can be approved: " + meta.current)
    }
    const row = meta.versions.find((entry) => entry.version === version)
    if (row === undefined) throw storeError("not-found", "version not found: " + version)
    if (row.approvedAt !== undefined) return row
    const stamped: ArtifactVersion = { ...row, approvedAt: new Date().toISOString() }
    await writeArtifactMeta(store, id, {
      ...meta,
      updatedAt: new Date().toISOString(),
      versions: meta.versions.map((entry) => (entry.version === version ? stamped : entry)),
    })
    return stamped
  })

export const readFeedbackDoc = async (store: Store, id: string, version: string): Promise<FeedbackDoc> => {
  try {
    const raw = await readFile(feedbackDocPath(store, id, version), "utf8")
    return FeedbackDocSchema.parse(JSON.parse(raw))
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { version: version, updatedAt: epochTimestamp, threads: [] }
    throw error
  }
}

const writeFeedbackDoc = async (store: Store, id: string, version: string, doc: FeedbackDoc): Promise<void> => {
  await mkdir(artifactDir(store, id), { recursive: true })
  await writeFile(feedbackDocPath(store, id, version), JSON.stringify(doc, null, 2) + "\n", "utf8")
}

type ThreadLocation = {
  meta: ArtifactMeta
  version: string
  doc: FeedbackDoc
  thread: Thread
}

const findThread = async (store: Store, id: string, threadId: string): Promise<ThreadLocation> => {
  const meta = await readArtifactMeta(store, id)
  for (const entry of meta.versions) {
    const doc = await readFeedbackDoc(store, id, entry.version)
    const thread = doc.threads.find((candidate) => candidate.id === threadId)
    if (thread !== undefined) return { meta: meta, version: entry.version, doc: doc, thread: thread }
  }
  throw storeError("not-found", "thread not found: " + threadId)
}

export type AppendThreadInput = {
  version: string
  anchor: Anchor | null
  body: string
  author: Author
}

export const appendThread = async (store: Store, id: string, input: AppendThreadInput): Promise<Thread> =>
  withFileLock(feedbackDocPath(store, id, input.version), async () => {
    const meta = await readArtifactMeta(store, id)
    if (!meta.versions.some((entry) => entry.version === input.version)) {
      throw storeError("not-found", "version not found: " + input.version)
    }
    const doc = await readFeedbackDoc(store, id, input.version)
    const now = new Date().toISOString()
    const message: ThreadMessage = {
      id: newId("m"),
      author: input.author,
      kind: "text",
      body: input.body,
      createdAt: now,
    }
    const thread: Thread = {
      id: newId("t"),
      status: "open",
      anchor: input.anchor,
      anchorVersion: input.version,
      messages: [message],
      createdAt: now,
    }
    await writeFeedbackDoc(store, id, input.version, {
      ...doc,
      updatedAt: now,
      threads: [...doc.threads, thread],
    })
    return thread
  })

export type AppendThreadMessageInput = {
  body: string
  author: Author
  kind?: MessageKind
}

export const appendThreadMessage = async (
  store: Store,
  id: string,
  threadId: string,
  input: AppendThreadMessageInput,
): Promise<Thread> => {
  const location = await findThread(store, id, threadId)
  return withFileLock(feedbackDocPath(store, id, location.version), async () => {
    const doc = await readFeedbackDoc(store, id, location.version)
    const thread = doc.threads.find((candidate) => candidate.id === threadId)
    if (thread === undefined) throw storeError("not-found", "thread not found: " + threadId)
    const message: ThreadMessage = {
      id: newId("m"),
      author: input.author,
      kind: input.kind ?? "text",
      body: input.body,
      createdAt: new Date().toISOString(),
    }
    const updated: Thread = { ...thread, messages: [...thread.messages, message] }
    await writeFeedbackDoc(store, id, location.version, {
      ...doc,
      updatedAt: message.createdAt,
      threads: doc.threads.map((candidate) => (candidate.id === threadId ? updated : candidate)),
    })
    return updated
  })
}

// The agent's answer to a thinking placeholder: swap the kind, set the body.
// Placeholders are the only editable messages.
export const replaceThinkingMessage = async (
  store: Store,
  id: string,
  threadId: string,
  messageId: string,
  body: string,
): Promise<Thread> => {
  const location = await findThread(store, id, threadId)
  return withFileLock(feedbackDocPath(store, id, location.version), async () => {
    const doc = await readFeedbackDoc(store, id, location.version)
    const thread = doc.threads.find((candidate) => candidate.id === threadId)
    if (thread === undefined) throw storeError("not-found", "thread not found: " + threadId)
    const message = thread.messages.find((candidate) => candidate.id === messageId)
    if (message === undefined || message.kind !== "thinking") {
      throw storeError("not-found", "thinking message not found: " + messageId)
    }
    const updated: Thread = {
      ...thread,
      messages: thread.messages.map((candidate) =>
        candidate.id === messageId ? { ...candidate, kind: "text", body: body } : candidate,
      ),
    }
    await writeFeedbackDoc(store, id, location.version, {
      ...doc,
      updatedAt: new Date().toISOString(),
      threads: doc.threads.map((candidate) => (candidate.id === threadId ? updated : candidate)),
    })
    return updated
  })
}

export const setThreadStatus = async (
  store: Store,
  id: string,
  threadId: string,
  status: ThreadStatus,
): Promise<Thread> => {
  const location = await findThread(store, id, threadId)
  return withFileLock(feedbackDocPath(store, id, location.version), async () => {
    const doc = await readFeedbackDoc(store, id, location.version)
    const thread = doc.threads.find((candidate) => candidate.id === threadId)
    if (thread === undefined) throw storeError("not-found", "thread not found: " + threadId)
    const updated: Thread = {
      ...thread,
      status: status,
      resolvedInVersion: status === "resolved" ? location.meta.current : undefined,
    }
    await writeFeedbackDoc(store, id, location.version, {
      ...doc,
      updatedAt: new Date().toISOString(),
      threads: doc.threads.map((candidate) => (candidate.id === threadId ? updated : candidate)),
    })
    return updated
  })
}

export const listArtifacts = async (store: Store): Promise<ArtifactMeta[]> => {
  const entries = await readdir(store.artifactsDir, { withFileTypes: true })
  const loaded = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          return await readArtifactMeta(store, entry.name)
        } catch (error) {
          console.error("redline: skipping unreadable artifact " + entry.name, error)
          return null
        }
      }),
  )
  return loaded
    .filter((meta): meta is ArtifactMeta => meta !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

const feedbackFilePattern = /^v\d+-feedback\.json$/

const readAllFeedbackDocs = async (store: Store, id: string): Promise<FeedbackDoc[]> => {
  const files = await readdir(artifactDir(store, id)).catch(() => [])
  const docs = await Promise.all(
    files
      .filter((file) => feedbackFilePattern.test(file))
      .map(async (file) => {
        try {
          const raw = await readFile(join(artifactDir(store, id), file), "utf8")
          return FeedbackDocSchema.parse(JSON.parse(raw))
        } catch (error) {
          console.error("redline: skipping unreadable feedback file " + file, error)
          return null
        }
      }),
  )
  return docs.filter((doc): doc is FeedbackDoc => doc !== null)
}

export const countOpenThreads = async (store: Store, id: string): Promise<number> => {
  const docs = await readAllFeedbackDocs(store, id)
  return docs.reduce(
    (total, doc) =>
      total + doc.threads.filter((thread) => thread.status === "open").length,
    0,
  )
}

// The artifact-scoped feedback view. Threads are stored per version, but a
// thread belongs to the artifact: it is anchored on the version it was pinned
// on and stays visible until it is resolved. The default view returns every
// thread, open ones first. With `anchoredAt`, only threads pinned on that
// version are returned.
export const readFeedbackView = async (
  store: Store,
  id: string,
  anchoredAt?: string,
): Promise<FeedbackView> => {
  const meta = await readArtifactMeta(store, id)
  if (anchoredAt !== undefined && !meta.versions.some((entry) => entry.version === anchoredAt)) {
    throw storeError("not-found", "version not found: " + anchoredAt)
  }
  const docs = await readAllFeedbackDocs(store, id)
  let threads: Thread[] = []
  for (const doc of docs) {
    for (const thread of doc.threads) {
      threads.push({ ...thread, anchorVersion: thread.anchorVersion ?? doc.version })
    }
  }
  if (anchoredAt !== undefined) {
    threads = threads.filter((thread) => thread.anchorVersion === anchoredAt)
  }
  // Newest first, always: the review UI pins the freshest thread at the
  // top, resolved or not.
  const byCreatedAtDesc = (a: Thread, b: Thread): number => b.createdAt.localeCompare(a.createdAt)
  const updatedAt = docs.reduce(
    (latest, doc) => (doc.updatedAt > latest ? doc.updatedAt : latest),
    meta.updatedAt,
  )
  const currentRow = meta.versions.find((entry) => entry.version === meta.current)
  return {
    version: anchoredAt ?? meta.current,
    current: meta.current,
    updatedAt: updatedAt,
    iteratedAt: meta.iteratedAt ?? epochTimestamp,
    artifactStatus: meta.status,
    artifactUpdatedAt: meta.updatedAt,
    approvedAt: currentRow?.approvedAt,
    versions: meta.versions,
    threads: [...threads].sort(byCreatedAtDesc),
  }
}
