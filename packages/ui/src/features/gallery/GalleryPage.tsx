import { useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import React from "react"
import { queryKeys } from "../../app/api/query.keys"
import { SiteHeader } from "../../components/SiteHeader"
import { Spinner } from "../../components/Spinner"
import { ArtifactCard } from "./ArtifactCard"
import { CreateDialog } from "./CreateDialog"
import { useArtifactsQuery, useHealthQuery } from "./queries"

const tagline = "review loop for design artifacts: architecture docs, decision records, API contracts, diagrams, UI mockups"

export const GalleryPage: React.FC = () => {
  const artifactsQuery = useArtifactsQuery()
  const healthQuery = useHealthQuery()
  const [createOpen, setCreateOpen] = React.useState(false)
  const queryClient = useQueryClient()

  const close = () => {
    setCreateOpen(false)
    void queryClient.invalidateQueries({ queryKey: queryKeys.artifacts.all })
  }

  return (
    <div className="min-h-screen">
      <SiteHeader tagline={tagline} home={healthQuery.data?.home}>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-edge-strong bg-panel px-2.5 py-1 text-xs text-fog hover:border-hover"
        >
          <Plus className="size-3.5" aria-hidden /> New artifact
        </button>
      </SiteHeader>
      <main className="px-7 pt-5 pb-10">
        {artifactsQuery.isPending ? (
          <p className="flex items-center gap-2 text-mist">
            <Spinner /> loading artifacts…
          </p>
        ) : artifactsQuery.isError ? (
          <p className="text-warn">{artifactsQuery.error.message}</p>
        ) : artifactsQuery.data.length === 0 ? (
          <p className="text-mist">
            No artifacts yet. Create one with <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs">POST /api/v1/artifacts</code>.
          </p>
        ) : (
          <section className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-3.5">
            {artifactsQuery.data.map((item) => (
              <ArtifactCard key={item.id} item={item} />
            ))}
          </section>
        )}
      </main>
      {createOpen ? <CreateDialog onClose={close} /> : null}
    </div>
  )
}
