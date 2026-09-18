/** Preserve the worker's SQLite classification independently of the host's native error types. */
export class SessionStoreSummaryReadError extends Error {
  constructor(
    error: Error,
    readonly transientSqlite: boolean,
  ) {
    super(error.message, { cause: error });
    this.name = error.name;
  }
}
