const paths = {
  open: "M5 19h14M5 5h6l2 3h6v11H5z",
  read: "M5 4h14v16H5zM8 8h8M8 12h8M8 16h5",
  click: "M6 3v15l4-4 3 6 2-1-3-6h5z",
  fill: "M4 6h16M6 3v6m12-6v6M5 12h14v8H5z",
  screenshot: "M4 7h4l2-2h4l2 2h4v12H4zM12 11a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  tabs: "M3 5h8v14H3zM13 5h8v14h-8z",
  other: "M12 3v3m0 12v3m9-9h-3M6 12H3m15.4-6.4-2.1 2.1M7.7 16.3l-2.1 2.1m12.8 0-2.1-2.1m-8.6-8.6L5.6 5.6",
  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-3.5 3.6-6 8-6s8 2.5 8 6",
  expand: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
  collapse: "M20 10h-6V4M4 14h6v6M14 10l7-7M3 21l7-7",
  chevronUp: "m6 15 6-6 6 6",
  chevronDown: "m6 9 6 6 6-6",
} as const

export type BrowserIconName = keyof typeof paths

export const getBrowserIconName = (kind: string): BrowserIconName =>
  Object.hasOwn(paths, kind) ? (kind as BrowserIconName) : "other"

export const BrowserIcon = ({ name }: { name: BrowserIconName }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={paths[name]} />
  </svg>
)
