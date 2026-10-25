// An append is visible before it finishes; only the newline commits a record.
export const getCompleteJsonlRecords = <Frame>(text: string): Frame[] =>
  text
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line) as Frame)
