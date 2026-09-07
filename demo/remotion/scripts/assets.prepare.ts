// Hardlinks the demo recordings into public/ so staticFile() can serve them.
// A symlink would not be dereferenced when Remotion bundles public/.
//
// Run: bun run prepare-assets

import { existsSync } from 'node:fs'
import { copyFile, link, mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(here, '..')
const publicDir = path.join(rootDir, 'public')
const demoDir = path.resolve(rootDir, '..')

const recordings = ['01-terminal.mp4', '02-redline.mp4'] as const

await mkdir(publicDir, { recursive: true })

for (const recording of recordings) {
  const source = path.join(demoDir, recording)
  const target = path.join(publicDir, recording)
  if (existsSync(target)) {
    await unlink(target)
  }
  try {
    await link(source, target)
    console.log(`hardlinked ${recording} into public/`)
  } catch {
    await copyFile(source, target)
    console.log(`copied ${recording} into public/`)
  }
}
