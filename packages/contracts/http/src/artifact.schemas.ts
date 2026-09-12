import { z } from "zod"

import {
  AnchorSchema,
  ArtifactIdSchema,
  ArtifactStatusSchema,
  ArtifactVersionSchema,
  AuthorSchema,
  IsoTimestampSchema,
  ThreadSchema,
  ThreadStatusSchema,
  VersionSchema,
} from "./artifact.models"

export const IdParamsSchema = z.object({ id: ArtifactIdSchema })

export const ThreadParamsSchema = z.object({
  id: ArtifactIdSchema,
  threadId: z.string().min(1),
})

export const MessageParamsSchema = z.object({
  id: ArtifactIdSchema,
  threadId: z.string().min(1),
  messageId: z.string().min(1),
})

export const ApproveParamsSchema = z.object({
  id: ArtifactIdSchema,
  version: VersionSchema,
})

export const CreateArtifactBodySchema = z.object({
  title: z.string().min(1).max(200),
  prompt: z.string().max(4000).default(""),
  note: z.string().max(500).optional(),
  html: z.string().min(1).max(5_000_000),
  // Project directory the artifact was produced from. Mandatory: sessions
  // for Iterate and comment duties spawn there.
  cwd: z.string().trim().min(1).max(4096),
})

export type CreateArtifactBody = z.infer<typeof CreateArtifactBodySchema>

export const AddVersionBodySchema = z.object({
  html: z.string().min(1).max(5_000_000),
  note: z.string().max(500).optional(),
})

export const AssetParamsSchema = z.object({ id: ArtifactIdSchema })

// Attach a static asset to one version: base64-encoded bytes (PNG, JPG,
// WebP, GIF, SVG, AVIF). Decoded size is capped in the store (5 MB); the
// base64 text stays under the server's 10 MB body limit.
export const CreateAssetBodySchema = z.object({
  version: VersionSchema,
  filename: z.string().min(1).max(120),
  data: z.base64(),
})

export type CreateAssetBody = z.infer<typeof CreateAssetBodySchema>

export const PatchMessageBodySchema = z.object({
  body: z.string().min(1).max(10000),
})

export const CreateThreadBodySchema = z.object({
  version: VersionSchema.optional(),
  anchor: AnchorSchema.nullable().default(null),
  body: z.string().min(1).max(10000),
  author: AuthorSchema.default("user"),
})

export const CreateThreadMessageBodySchema = z.object({
  body: z.string().min(1).max(10000),
  author: AuthorSchema.default("user"),
})

export const PatchThreadBodySchema = z.object({ status: ThreadStatusSchema })

export const FeedbackQuerySchema = z.object({
  version: VersionSchema.optional(),
  after: IsoTimestampSchema.optional(),
  wait: z.coerce.number().int().min(0).max(300).optional(),
})

// ---------- responses ----------

export const HealthSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  version: z.string(),
  home: z.string(),
})

export type Health = z.infer<typeof HealthSchema>

// Gallery row: one artifact summarized for list views.
export const ArtifactSummarySchema = z.object({
  id: ArtifactIdSchema,
  title: z.string(),
  status: ArtifactStatusSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  current: VersionSchema,
  versionCount: z.number(),
  openThreads: z.number(),
  reviewUrl: z.string(),
  assetsCount: z.number(),
  reviewer: z.enum(["none", "starting", "idle"]),
  worker: z.enum(["none", "idle"]),
})

export type ArtifactSummary = z.infer<typeof ArtifactSummarySchema>

export const ArtifactListSchema = z.array(ArtifactSummarySchema)

// The artifact-scoped feedback view behind GET /artifacts/:id/feedback:
// every thread plus the version ledger and lane/status context.
export const FeedbackViewSchema = z.object({
  version: VersionSchema,
  current: VersionSchema,
  updatedAt: IsoTimestampSchema,
  iteratedAt: IsoTimestampSchema,
  artifactStatus: ArtifactStatusSchema,
  artifactUpdatedAt: IsoTimestampSchema,
  approvedAt: IsoTimestampSchema.optional(),
  versions: z.array(ArtifactVersionSchema),
  threads: z.array(ThreadSchema),
  // Lane presence fields the feedback route adds on the wire.
  agentAttached: z.boolean().optional(),
  reviewerAttached: z.boolean().optional(),
  workerRunning: z.boolean().optional(),
  // True while an iteration duty is in flight with a fresh heartbeat. False
  // (or absent) while iterating means: orphaned or wedged — offer Stop.
  workerLive: z.boolean().optional(),
})

export type FeedbackView = z.infer<typeof FeedbackViewSchema>
