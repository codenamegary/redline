import { z } from "zod"

export const artifactStatuses = ["draft", "review", "iterating"] as const

export const ArtifactStatusSchema = z.enum(artifactStatuses)

export type ArtifactStatus = (typeof artifactStatuses)[number]

export const threadStatuses = ["open", "resolved"] as const

export const ThreadStatusSchema = z.enum(threadStatuses)

export type ThreadStatus = (typeof threadStatuses)[number]

export const authors = ["user", "agent"] as const

export const AuthorSchema = z.enum(authors)

export type Author = (typeof authors)[number]

export const messageKinds = ["text", "thinking"] as const

export const MessageKindSchema = z.enum(messageKinds)

export type MessageKind = (typeof messageKinds)[number]

export const versionPattern = /^v\d+$/

export const VersionSchema = z.string().regex(versionPattern)

export type Version = z.infer<typeof VersionSchema>

export const IsoTimestampSchema = z.iso.datetime()

export const AnchorRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
})

export type AnchorRect = z.infer<typeof AnchorRectSchema>

export const AnchorSchema = z.object({
  selector: z.string().min(1).max(2000),
  text: z.string().max(400),
  rect: AnchorRectSchema.optional(),
})

export type Anchor = z.infer<typeof AnchorSchema>

export const ThreadMessageSchema = z.object({
  id: z.string().min(1),
  author: AuthorSchema,
  // "thinking" marks a server-synthesized placeholder the agent replaces
  // via PATCH; everything else is an immutable conversation message.
  kind: MessageKindSchema,
  body: z.string().min(1).max(10000),
  createdAt: IsoTimestampSchema,
})

export type ThreadMessage = z.infer<typeof ThreadMessageSchema>

export const ThreadSchema = z.object({
  id: z.string().min(1),
  status: ThreadStatusSchema,
  anchor: AnchorSchema.nullable(),
  // Version the thread was pinned on. The store stamps it on write.
  anchorVersion: VersionSchema.optional(),
  // Version that was current when the thread was resolved. Absent while the
  // thread is open.
  resolvedInVersion: VersionSchema.optional(),
  messages: z.array(ThreadMessageSchema).min(1),
  createdAt: IsoTimestampSchema,
})

export type Thread = z.infer<typeof ThreadSchema>

export const FeedbackDocSchema = z.object({
  version: VersionSchema,
  updatedAt: IsoTimestampSchema,
  threads: z.array(ThreadSchema),
})

export type FeedbackDoc = z.infer<typeof FeedbackDocSchema>

export const VersionBatchSchema = z.object({
  // Open thread ids frozen when the user hit Iterate. This batch is the
  // agent's work contract for the version it will publish.
  threadIds: z.array(z.string().min(1)),
  submittedAt: IsoTimestampSchema,
})

export type VersionBatch = z.infer<typeof VersionBatchSchema>

export const ArtifactVersionSchema = z.object({
  version: VersionSchema,
  note: z.string().max(500).optional(),
  createdAt: IsoTimestampSchema,
  // The version row is born at Iterate (batch set, publishedAt absent) and
  // completed at publish. v1 is born published.
  publishedAt: IsoTimestampSchema.optional(),
  approvedAt: IsoTimestampSchema.optional(),
  batch: VersionBatchSchema.optional(),
})

export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>

// A version row is pending between Iterate and publish.
export const isPendingVersion = (version: ArtifactVersion): boolean =>
  version.batch !== undefined && version.publishedAt === undefined

export const pendingVersion = (meta: ArtifactMeta): ArtifactVersion | undefined =>
  meta.versions.find((version) => isPendingVersion(version))

export const ArtifactIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,118}$/)

export type ArtifactId = z.infer<typeof ArtifactIdSchema>

// Where the create request came from (host plugin session). Stored on the
// artifact so origin notifications can find their way home. cwd records the
// project directory at create time; worker sessions spawn there so duties
// can read the repo that produced the artifact (read-only).
export const OriginRefSchema = z.object({
  host: z.string().min(1),
  sessionId: z.string().min(1),
  serverUrl: z.string().optional(),
  cwd: z.string().min(1).optional(),
})

export type OriginRef = z.infer<typeof OriginRefSchema>

export const ArtifactMetaSchema = z.object({
  id: ArtifactIdSchema,
  title: z.string().min(1).max(200),
  prompt: z.string().max(4000),
  status: ArtifactStatusSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  // Last time the user hit Iterate. Separate from updatedAt so waiters can
  // tell work duty (iteratedAt moved) from reply duty (thread activity).
  iteratedAt: IsoTimestampSchema.optional(),
  current: VersionSchema,
  versions: z.array(ArtifactVersionSchema).min(1),
  origin: OriginRefSchema.optional(),
})

export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>
