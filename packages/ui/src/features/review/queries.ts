import { ThreadStatus, Version, ArtifactMetaSchema } from "@redline/http-contracts/artifact.models"
import { FeedbackViewSchema, FeedbackView } from "@redline/http-contracts/artifact.schemas"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { httpGet, httpPatch, httpPost } from "../../app/api/client"
import { queryKeys } from "../../app/api/query.keys"

export const useArtifactQuery = (id: string) =>
  useQuery({
    queryKey: queryKeys.artifact(id),
    queryFn: async () => ArtifactMetaSchema.parse(await httpGet("/api/v1/artifacts/" + id)),
  })

export const useFeedbackQuery = (id: string, pollMs: number | false) =>
  useQuery({
    queryKey: queryKeys.feedback(id),
    queryFn: async (): Promise<FeedbackView> =>
      FeedbackViewSchema.parse(await httpGet("/api/v1/artifacts/" + id + "/feedback")),
    refetchInterval: pollMs === false ? false : pollMs,
  })

export const useIterateMutation = (id: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<unknown> => httpPost("/api/v1/artifacts/" + id + "/iterations", {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.feedback(id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.artifacts.all })
    },
  })
}

export const useApproveMutation = (id: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (version: Version): Promise<unknown> =>
      httpPost("/api/v1/artifacts/" + id + "/versions/" + version + "/approve", {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.feedback(id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.artifacts.all })
    },
  })
}

export const useCreateThreadMutation = (id: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      version: Version
      anchor: unknown
      body: string
    }): Promise<unknown> => httpPost("/api/v1/artifacts/" + id + "/feedback", input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.feedback(id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.artifacts.all })
    },
  })
}

export const useReplyMutation = (id: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { threadId: string; body: string }): Promise<unknown> =>
      httpPost("/api/v1/artifacts/" + id + "/threads/" + input.threadId + "/messages", {
        body: input.body,
        author: "user",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.feedback(id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.artifacts.all })
    },
  })
}

export const useThreadStatusMutation = (id: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { threadId: string; status: ThreadStatus }): Promise<unknown> =>
      httpPatch("/api/v1/artifacts/" + id + "/threads/" + input.threadId, { status: input.status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.feedback(id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.artifacts.all })
    },
  })
}
