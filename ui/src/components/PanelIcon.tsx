export type PanelIconName =
  | "close"
  | "folder"
  | "file"
  | "back"
  | "download"
  | "refresh"
  | "clock"
  | "settings"
  | "shield"
  | "computer"
  | "expand"
  | "collapse"
  | "archive"
  | "trash"
  | "panel"
  | "plus"
  | "warning"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "arrow-right"
  | "check"
  | "people"

const paths: Record<PanelIconName, string> = {
  close: "m6 6 12 12M18 6 6 18",
  folder: "M3 7V5h7l2 2h9v13H3V7Z",
  file: "M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h6",
  back: "m10 5-7 7 7 7M3 12h18",
  download: "M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4",
  refresh: "M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2",
  settings: "M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6",
  shield: "M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z",
  computer: "M3 4h18v13H3V4Zm9 13v4m-5 0h10",
  expand: "M8 3H3v5m0-5 7 7m6 11h5v-5m0 5-7-7M21 8V3h-5m5 0-7 7M3 16v5h5m-5 0 7-7",
  collapse: "M8 3v5H3m5-5L3 8m13 13v-5h5m-5 5 5-5M21 8h-5V3m5 5-7-7M3 16h5v5m-5-5 7 7",
  archive: "M3 4h18v4H3V4Zm2 4v12h14V8m-9 3h4",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  panel: "M4 4h16v16H4zM12 4v16",
  plus: "M12 5v14M5 12h14",
  warning: "M12 3 2.5 20h19L12 3Zm0 6v5m0 3v.01",
  "chevron-down": "m6 9 6 6 6-6",
  "chevron-left": "m15 18-6-6 6-6",
  "chevron-right": "m9 18 6-6-6-6",
  "arrow-right": "M5 12h14m-7-7 7 7-7 7",
  check: "m5 12 5 5 9-10",
  people: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 10v-1a6 6 0 0 1 12 0v1m3-10a3 3 0 1 0 0-6m5 16v-1a5 5 0 0 0-3-4.6",
}

export const PanelIcon = ({ name }: { name: PanelIconName }) => (
  <svg
    className="panel-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d={paths[name]} />
  </svg>
)
