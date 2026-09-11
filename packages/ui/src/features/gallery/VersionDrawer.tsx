import { ArtifactVersion, isPendingVersion, Version } from "@redline/http-contracts/artifact.models"
import { Check, MessagesSquare } from "lucide-react"
import React from "react"
import { Link } from "react-router"
import { countLabel, shortDate } from "../../components/format"
import { versionOptionLabel } from "../review/VersionsSelect"

export type VersionDrawerProps = {
  artifactId: string
  versions: ArtifactVersion[]
  current: Version
  commentCounts: Map<Version, number>
}

// Hover drawer that lives BEHIND the card: absolutely anchored 1px below
// the card's bottom edge (so the card's border cleanly separates them),
// 30px narrower than the card, with a 4px green bottom edge that peeks
// out below the card even at rest. The outer wrapper clips at that line,
// so a tall drawer slides away underneath without ever surfacing above
// the card; the extra wrapper padding gives the shadow room. Hover raises
// the card above its neighbors and slides the drawer down out from
// underneath — no layout shift anywhere. One horizontal row per version,
// newest first; each row deep-links into the review UI with that version
// open (?v=). Pending iterations have no document yet, so their rows are
// inert.
export const VersionDrawer: React.FC<VersionDrawerProps> = ({ artifactId, versions, current, commentCounts }) => {
  const rows = versions.slice().reverse()
  return (
    <div className="absolute inset-x-[7px] top-full z-[-1] mt-px overflow-hidden pb-4">
      <div className="mx-2 flex translate-y-[calc(6px_-_100%)] flex-col gap-px rounded-b-[10px] border border-t-0 border-edge border-b-4 border-b-go bg-card p-1.5 shadow-lg transition-[translate] duration-200 ease-out group-hover/card:translate-y-0 group-focus-within/card:translate-y-0 motion-reduce:transition-none">
        {rows.map((entry) => {
          const approved = entry.approvedAt !== undefined
          const pending = isPendingVersion(entry)
          const comments = commentCounts.get(entry.version) ?? 0
          const row = (
            <>
              <span className={entry.version === current ? "font-semibold text-fog" : undefined}>
                {entry.version}
              </span>
              {approved ? <Check className="size-3 shrink-0 text-go" aria-hidden /> : null}
              {pending ? <span className="text-warn">pending</span> : null}
              <span className="ml-auto flex items-center gap-2.5 tabular-nums">
                {comments > 0 ? (
                  <span className="flex items-center gap-1">
                    <MessagesSquare className="size-3" aria-hidden />
                    {countLabel(comments, "comment")}
                  </span>
                ) : null}
                {entry.publishedAt !== undefined ? <span>{shortDate(entry.publishedAt)}</span> : null}
              </span>
            </>
          )
          const className =
            "flex items-center gap-2 rounded-md bg-panel/40 px-2 py-1 font-mono text-[11px] text-mist transition-colors hover:bg-panel/80"
          return pending ? (
            <div key={entry.version} title={versionOptionLabel(entry)} aria-label={label(entry, comments)} className={className + " cursor-default"}>
              {row}
            </div>
          ) : (
            <Link
              key={entry.version}
              to={"/a/" + artifactId + "?v=" + entry.version}
              title={versionOptionLabel(entry)}
              aria-label={label(entry, comments)}
              className={className + " no-underline"}
            >
              {row}
            </Link>
          )
        })}
      </div>
    </div>
  )
}

const label = (entry: ArtifactVersion, comments: number): string => {
  const bits = [entry.version]
  if (entry.approvedAt !== undefined) bits.push("approved")
  if (isPendingVersion(entry)) bits.push("pending")
  if (comments > 0) bits.push(countLabel(comments, "comment"))
  return bits.join(" · ")
}
