import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  Anchor,
  ArtifactMeta,
  ArtifactMetaSchema,
  ArtifactStatus,
  Author,
  FeedbackDoc,
  FeedbackDocSchema,
  Thread,
  ThreadMessage,
  ThreadStatus,
  VersionSchema,
} from "./artifact.models"
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

export const artifactVersionDir = (store: Store, id: string, version: string): string =>
  join(artifactDir(store, id), version)

export const artifactFeedbackDir = (store: Store, id: string): string =>
  join(artifactDir(store, id), "feedback")

const feedbackDocPath = (store: Store, id: string, version: string): string =>
  join(artifactFeedbackDir(store, id), version + ".json")

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
    versions: [{ version: VersionSchema.parse("v1"), createdAt: now, note: input.note }],
  }
  const firstVersionDir = artifactVersionDir(store, id, "v1")
  await mkdir(firstVersionDir, { recursive: true })
  await writeFile(join(firstVersionDir, "index.html"), input.html, "utf8")
  await writeArtifactMeta(store, id, meta)
  return meta
}

export type AddVersionInput = {
  html: string
  note?: string
}

export const addArtifactVersion = async (
  store: Store,
  id: string,
  input: AddVersionInput,
): Promise<ArtifactMeta> =>
  withFileLock(artifactMetaPath(store, id), async () => {
    const meta = await readArtifactMeta(store, id)
    const version = VersionSchema.parse("v" + String(meta.versions.length + 1))
    const now = new Date().toISOString()
    const dir = artifactVersionDir(store, id, version)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "index.html"), input.html, "utf8")
    const updated: ArtifactMeta = {
      ...meta,
      status: "review",
      updatedAt: now,
      current: version,
      versions: [...meta.versions, { version: version, createdAt: now, note: input.note }],
    }
    await writeArtifactMeta(store, id, updated)
    return updated
  })

export const setArtifactStatus = async (
  store: Store,
  id: string,
  status: ArtifactStatus,
): Promise<ArtifactMeta> =>
  withFileLock(artifactMetaPath(store, id), async () => {
    const meta = await readArtifactMeta(store, id)
    const updated: ArtifactMeta = { ...meta, status: status, updatedAt: new Date().toISOString() }
    await writeArtifactMeta(store, id, updated)
    return updated
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
  await mkdir(artifactFeedbackDir(store, id), { recursive: true })
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

const feedbackFilePattern = /^v\d+\.json$/

const readAllFeedbackDocs = async (store: Store, id: string): Promise<FeedbackDoc[]> => {
  const files = await readdir(artifactFeedbackDir(store, id)).catch(() => [])
  const docs = await Promise.all(
    files
      .filter((file) => feedbackFilePattern.test(file))
      .map(async (file) => {
        try {
          const raw = await readFile(join(artifactFeedbackDir(store, id), file), "utf8")
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

export type FeedbackView = {
  version: string
  updatedAt: string
  artifactStatus: ArtifactStatus
  artifactUpdatedAt: string
  threads: Thread[]
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
  const byCreatedAt = (a: Thread, b: Thread): number => a.createdAt.localeCompare(b.createdAt)
  const open = threads.filter((thread) => thread.status === "open").sort(byCreatedAt)
  const resolved = threads.filter((thread) => thread.status === "resolved").sort(byCreatedAt)
  const updatedAt = docs.reduce(
    (latest, doc) => (doc.updatedAt > latest ? doc.updatedAt : latest),
    meta.updatedAt,
  )
  return {
    version: anchoredAt ?? meta.current,
    updatedAt: updatedAt,
    artifactStatus: meta.status,
    artifactUpdatedAt: meta.updatedAt,
    threads: [...open, ...resolved],
  }
}
