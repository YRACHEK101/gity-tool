/** Render a minimal, dependency-free ASCII table. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );

  const line = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const fmtRow = (cols: string[]) =>
    "|" + widths.map((w, i) => " " + (cols[i] ?? "").padEnd(w) + " ").join("|") + "|";

  return [line, fmtRow(headers), line, ...rows.map(fmtRow), line].join("\n");
}
