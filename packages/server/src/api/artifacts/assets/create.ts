import { Buffer } from "node:buffer"

import { saveVersionAsset } from "../../../store/artifact.store"
import { AssetParamsSchema, CreateAssetBodySchema } from "@redline/http-contracts/artifact.schemas"
import { origin, RouteDescriptor, RoutesContext } from "../../routes.context"

// Attach a static asset (generated image and the like) to one version of
// the artifact. 404 for unknown artifact/version, 409 when the filename is
// taken on that version, 422 for empty or oversized bytes. Upload before
// publishing the HTML that references the file.
export const createAssetRoute = (ctx: RoutesContext): RouteDescriptor => ({
  method: "POST",
  url: "/api/v1/artifacts/:id/assets",
  handler: async (request, reply) => {
    const { id } = AssetParamsSchema.parse(request.params)
    const body = CreateAssetBodySchema.parse(request.body)
    const bytes = Buffer.from(body.data, "base64")
    const saved = await saveVersionAsset(ctx.store, id, body.version, body.filename, bytes)
    const from = origin(request)
    const url = from + "/a/" + id + "/" + body.version + "/" + saved.filename
    reply.header("location", url)
    return reply.status(201).send({
      artifactId: id,
      version: body.version,
      filename: saved.filename,
      size: bytes.byteLength,
      url: url,
    })
  },
})
