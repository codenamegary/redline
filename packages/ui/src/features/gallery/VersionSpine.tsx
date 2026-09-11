import { ArtifactVersion, Version } from "@redline/http-contracts/artifact.models"
import { Check } from "lucide-react"
import React from "react"
import { versionOptionLabel } from "../review/VersionsSelect"

export type VersionSpineProps = {
  versions: ArtifactVersion[]
  current: Version
}

// The card's left edge as a version timeline: one segment per version,
// newest on top. Approved segments wear the green tick (the current
// approval at full strength, superseded ones dimmed), a pending iteration
// pulses. Collapsed it is a 3px hairline rail; hovering the rail slides
// the drawer open with one labeled row per version. Clipped by container
// width, so labels are always laid out — nothing pops in.
export const VersionSpine: React.FC<VersionSpineProps> = ({ versions, current }) => {
  const rows = versions.slice().reverse()
  const list = rows.length > 0 ? rows : undefined
  return (
    <div
      aria-label={
        list === undefined
          ? "version timeline"
          : "version timeline: " +
            list
              .map((entry) =>
                entry.approvedAt !== undefined
                  ? entry.version + " approved"
                  : entry.batch !== undefined && entry.publishedAt === undefined
                    ? entry.version + " pending"
                    : entry.version,
              )
              .join(", ")
      }
      title="version timeline"
      className="group/spine absolute inset-y-2 left-0 z-10 flex w-[3px] cursor-default flex-col gap-[2px] overflow-hidden rounded-r-full bg-card transition-[width] duration-200 ease-out hover:w-[86px] focus-within:w-[86px] motion-reduce:transition-none"
    >
      {(list ?? [{ version: current } as ArtifactVersion]).map((entry) => {
        const approved = entry.approvedAt !== undefined
        const pending = entry.batch !== undefined && entry.publishedAt === undefined
        const isCurrent = entry.version === current
        const tint = approved
          ? "bg-go/15 text-go"
          : pending
            ? "bg-warn/15 text-warn motion-safe:animate-pulse"
            : "bg-edge-strong/20 text-mist"
        const label =
          entry.approvedAt !== undefined
            ? entry.version + " · approved"
            : pending
              ? entry.version + " · pending"
              : entry.version
        return (
          <div
            key={entry.version}
            title={versionOptionLabel(entry)}
            className={`flex min-h-[5px] flex-1 items-center gap-1 whitespace-nowrap rounded-r-full px-2 font-mono text-[10px] leading-none ${tint}`}
          >
            {approved ? (
              <Check
                className={`size-3 shrink-0 ${entry.version === current ? "" : "opacity-50"}`}
                aria-hidden
              />
            ) : null}
            <span className={isCurrent ? "font-semibold" : undefined}>{label}</span>
          </div>
        )
      })}
    </div>
  )
}
