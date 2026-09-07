import { z } from "zod"

import {
  AnchorSchema,
  ArtifactIdSchema,
  AuthorSchema,
  IsoTimestampSchema,
  OriginRefSchema,
  ThreadStatusSchema,
  VersionSchema,
} from "../store/artifact.models"

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
  origin: OriginRefSchema.optional(),
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
