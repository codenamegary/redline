import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArtifactListSchema,
  ArtifactSummarySchema,
} from "@redline/http-contracts/artifact.schemas"
import type { ArtifactSummary } from "@redline/http-contracts/artifact.schemas"
import { CreateArtifactBodySchema } from "@redline/http-contracts/artifact.schemas"
import type { CreateArtifactBody } from "@redline/http-contracts/artifact.schemas"
import { HealthSchema } from "@redline/http-contracts/artifact.schemas"

import { httpGet, httpPost } from "../../app/api/client"
import { queryKeys } from "../../app/api/query.keys"

export const useArtifactsQuery = () =>
  useQuery({
    queryKey: queryKeys.artifacts.all,
    queryFn: async () => ArtifactListSchema.parse(await httpGet("/api/v1/artifacts")),
  })

export const useHealthQuery = () =>
  useQuery({
    queryKey: queryKeys.health,
    queryFn: async () => HealthSchema.parse(await httpGet("/api/v1/health")),
    staleTime: 60_000,
  })

export const useCreateArtifactMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateArtifactBody): Promise<ArtifactSummary> => {
      const body = CreateArtifactBodySchema.parse(input)
      return ArtifactSummarySchema.parse(await httpPost("/api/v1/artifacts", body))
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.artifacts.all })
    },
  })
}
