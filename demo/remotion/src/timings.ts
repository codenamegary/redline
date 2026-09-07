export const FPS = 30
export const WIDTH = 1440
export const HEIGHT = 810

// A span of a source recording: seconds in, seconds out, playback rate.
// Keep rate at 16 or below: browser media elements (used by the Studio
// preview) throw NotSupportedError above 16x. Renders are not affected.
export type MediaCut = {
  readonly label: string
  readonly start: number
  readonly end: number
  readonly rate: number
  // Punch-in zooms while this cut plays. Times are source seconds, focus is
  // in native source pixels (02-redline.mp4 is 1920x1080).
  readonly zooms?: readonly ZoomEffect[]
  readonly cursors?: readonly CursorEffect[]
}

export type ZoomEffect = {
  // Zoomed window in source seconds. Full frame between windows. The camera
  // needs 0.25s (timeline) * rate of source time to ease in and out, so a
  // zoom must start at or after its cut begins and end no later than the
  // cut end plus that same allowance.
  readonly start: number
  readonly end: number
  // Point of interest in source pixels, centered while zoomed.
  readonly focus: readonly [number, number]
  // Optional pan origin: the camera drifts from this point to `focus` while
  // zooming in.
  readonly focusFrom?: readonly [number, number]
  readonly zoom: number
}

// A synthetic mouse pointer for actions the screen recording did not capture.
// Coordinates are native source pixels; times are source seconds.
export type CursorEffect = {
  readonly label: string
  readonly from: readonly [number, number]
  readonly to: readonly [number, number]
  // Spawn, reach the target, click ripple, finished fading.
  readonly start: number
  readonly arrive: number
  readonly click: number
  readonly until: number
}

export const cutFrames = (cut: MediaCut): number =>
  Math.round(((cut.end - cut.start) / cut.rate) * FPS)

export const sectionFrames = (cuts: readonly MediaCut[]): number =>
  cuts.reduce((sum, cut) => sum + cutFrames(cut), 0)

// demo/01-terminal.mp4 (606.4s). Cut points in seconds, measured against the
// 01-terminal.tape script: install finishes ~12s, the prompt is typed by
// ~23s, then the worker agent builds.
export const terminalCuts: readonly MediaCut[] = [
  { label: '1 · install the skill', start: 0, end: 12, rate: 1 },
  { label: '2 · prompt the agent', start: 12, end: 24, rate: 1 },
  { label: '3 · the worker agent builds v1', start: 24, end: 90, rate: 16 },
  { label: '4 · the artifact lands', start: 500, end: 508, rate: 1 },
]

// demo/02-redline.mp4 (150.9s, 1080p). One cut per beat, verified against
// the recording:
//   1.5-2.0s    "+ Comment" arm click (button flips to "Click an element...")
//   3.5-4.1s    legend element pick, opens the composer
//   5.4-10.5s   typing "Apply custom styling...", save ~11.5s
//   43.8-44.2s  second arm click
//   ~45.2s      "API contracts" title click (not captured; synthetic cursor)
//   45.4-59.5s  typing "Add a high level sequence diagram...", save ~60s
//   74.0-74.4s  third arm click
//   ~75.8s      "9500 cents" cell click (synthetic cursor)
//   76.2-100s   typing "Format these numbers as dollars and cents...", save ~101.5s
//   ~107s       Iterate, v2 lands with the live diff
export const reviewCuts: readonly MediaCut[] = [
  {
    label: 'redline the artifact · opening',
    start: 0,
    end: 4.7,
    rate: 1,
    zooms: [
      { start: 1.1, end: 2.6, focus: [1624, 48], zoom: 2.2 },
      { start: 3.2, end: 4.4, focus: [340, 760], zoom: 2.0 },
    ],
  },
  {
    label: 'comment · apply custom styling',
    start: 4.7,
    end: 12.8,
    rate: 4,
    zooms: [{ start: 4.7, end: 11.8, focus: [1690, 330], zoom: 2.0 }],
  },
  { label: 'the first reply lands', start: 12.8, end: 43.3, rate: 2 },
  {
    label: 'comment · api contracts arm',
    start: 43.3,
    end: 44.7,
    rate: 1,
    zooms: [{ start: 43.55, end: 44.45, focus: [1624, 48], zoom: 2.2 }],
  },
  {
    label: 'pick · api contracts',
    start: 44.7,
    end: 46.5,
    rate: 1,
    zooms: [{ start: 44.95, end: 46.2, focus: [810, 640], zoom: 2.0 }],
    cursors: [
      {
        label: 'api contracts click',
        from: [1624, 60],
        to: [860, 800],
        start: 44.75,
        arrive: 45.1,
        click: 45.2,
        until: 46.3,
      },
    ],
  },
  {
    label: 'comment · sequence diagram',
    start: 46.5,
    end: 61.2,
    rate: 4,
    zooms: [{ start: 46.5, end: 60.2, focus: [1690, 330], zoom: 2.0 }],
  },
  { label: 'the replies land', start: 61.2, end: 73.3, rate: 2 },
  {
    label: 'comment · 9500 cents arm',
    start: 73.3,
    end: 74.9,
    rate: 1,
    zooms: [{ start: 73.55, end: 74.65, focus: [1624, 48], zoom: 2.2 }],
  },
  {
    label: 'pick · 9500 cents',
    start: 74.9,
    end: 78.3,
    rate: 1,
    zooms: [
      { start: 75.15, end: 76.0, focus: [1289, 359], zoom: 2.2 },
      {
        start: 76.5,
        end: 78.05,
        focus: [1690, 330],
        focusFrom: [1289, 359],
        zoom: 2.0,
      },
    ],
    cursors: [
      {
        label: '9500 cents click',
        from: [1624, 60],
        to: [1289, 359],
        start: 74.95,
        arrive: 75.55,
        click: 75.7,
        until: 76.9,
      },
    ],
  },
  {
    label: 'comment · dollars and cents',
    start: 78.3,
    end: 102.0,
    rate: 4,
    zooms: [{ start: 78.3, end: 101.0, focus: [1690, 330], zoom: 2.0 }],
  },
  { label: 'iterate · v2 lands', start: 102.0, end: 150, rate: 2 },
]

export const outroSeconds = 5
export const transitionFrames = 15

export const terminalFrames = sectionFrames(terminalCuts)
export const reviewFrames = sectionFrames(reviewCuts)

// Three segments joined by two crossfades.
export const demoFrames =
  terminalFrames + reviewFrames + outroSeconds * FPS - 2 * transitionFrames
