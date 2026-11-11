export class MoggingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}
export class ValidationError extends MoggingError {
  constructor(message: string) { super("validation_error", message); }
}
export class ConflictError extends MoggingError {
  constructor(message: string) { super("conflict", message); }
}
export class NotPublishableError extends MoggingError {
  constructor(message: string) { super("not_publishable", message); }
}
export class StaleReleaseError extends MoggingError {
  constructor(message: string) { super("stale_release", message); }
}
export class NotFoundError extends MoggingError {
  constructor(message: string) { super("not_found", message); }
}
