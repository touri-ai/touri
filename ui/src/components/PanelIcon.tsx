type Name =
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
  | "archive"
  | "trash"

const paths: Record<Name, string> = {
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
  archive: "M3 4h18v4H3V4Zm2 4v12h14V8m-9 3h4",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
}

export const PanelIcon = ({ name }: { name: Name }) => (
  <svg
    className="panel-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d={paths[name]} />
  </svg>
)
