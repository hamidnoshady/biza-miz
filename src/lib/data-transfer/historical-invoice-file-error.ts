export class HistoricalFileError extends Error {
  constructor(readonly code: string) { super(code); this.name = "HistoricalFileError"; }
}
