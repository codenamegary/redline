import { QueryClient } from "@tanstack/react-query"

export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: 3_000,
      },
    },
  })
