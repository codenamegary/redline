import { z } from "zod"

export const artifactStatuses = ["draft", "review", "approved"] as const

export const ArtifactStatusSchema = z.enum(artifactStatuses)

export type ArtifactStatus = (typeof artifactStatuses)[number]

export const threadStatuses = ["open", "resolved"] as const

export const ThreadStatusSchema = z.enum(threadStatuses)

export type ThreadStatus = (typeof threadStatuses)[number]

export const authors = ["user", "agent"] as const

export const AuthorSchema = z.enum(authors)

export type Author = (typeof authors)[number]

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
  body: z.string().min(1).max(10000),
  createdAt: IsoTimestampSchema,
})

export type ThreadMessage = z.infer<typeof ThreadMessageSchema>

export const ThreadSchema = z.object({
  id: z.string().min(1),
  status: ThreadStatusSchema,
  anchor: AnchorSchema.nullable(),
  // Version the thread was pinned on. Optional in the schema so legacy
  // feedback files parse; the store stamps it on write and derives it from
  // the feedback file name when missing.
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

export const ArtifactVersionSchema = z.object({
  version: VersionSchema,
  note: z.string().max(500).optional(),
  createdAt: IsoTimestampSchema,
})

export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>

export const ArtifactIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,118}$/)

export type ArtifactId = z.infer<typeof ArtifactIdSchema>

export const ArtifactMetaSchema = z.object({
  id: ArtifactIdSchema,
  title: z.string().min(1).max(200),
  prompt: z.string().max(4000),
  status: ArtifactStatusSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  current: VersionSchema,
  versions: z.array(ArtifactVersionSchema).min(1),
})

export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>
