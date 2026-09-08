import { RedlineSettingsSchema, SettingsDefaultsSchema, RedlineSettings, SettingsDefaults } from "@redline/http-contracts/settings.models"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { httpGet, httpPost, httpPut } from "../../app/api/client"
import { queryKeys } from "../../app/api/query.keys"

export const useSettingsQuery = () =>
  useQuery({
    queryKey: queryKeys.settings.all,
    queryFn: async (): Promise<RedlineSettings> =>
      RedlineSettingsSchema.parse(await httpGet("/api/v1/settings")),
  })

export const useDefaultsQuery = () =>
  useQuery({
    queryKey: queryKeys.defaults,
    queryFn: async (): Promise<SettingsDefaults> =>
      SettingsDefaultsSchema.parse(await httpGet("/api/v1/settings/defaults")),
    staleTime: Number.POSITIVE_INFINITY,
  })

export const useSaveSettingsMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (settings: RedlineSettings): Promise<RedlineSettings> =>
      RedlineSettingsSchema.parse(await httpPut("/api/v1/settings", settings)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.all })
    },
  })
}

export const useProbeMutation = () =>
  useMutation({
    mutationFn: async (input: {
      lane: "reviewer" | "worker"
      adapter: "acp"
      acpCommand: string[]
    }): Promise<unknown> => httpPost("/api/v1/settings/probe", input),
  })
