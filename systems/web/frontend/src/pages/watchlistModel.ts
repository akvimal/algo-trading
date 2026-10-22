// A watchlist's symbols are one comma-separated string (the shape a Rule scans), so adding and removing one is string work.

export const symbolsOf = (csv: string): string[] =>
  csv
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

export const hasSymbol = (csv: string, symbol: string): boolean => symbolsOf(csv).includes(symbol.toUpperCase());

export const addSymbol = (csv: string, symbol: string): string => (hasSymbol(csv, symbol) ? symbolsOf(csv).join(",") : [...symbolsOf(csv), symbol.toUpperCase()].join(","));

export const removeSymbol = (csv: string, symbol: string): string =>
  symbolsOf(csv)
    .filter((s) => s !== symbol.toUpperCase())
    .join(",");
