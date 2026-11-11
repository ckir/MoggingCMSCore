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
export type LicenceErrorCode = "LICENCE_INVALID" | "LICENCE_EXPIRED" | "LICENCE_REQUIRED";
/** Licence key verification failure, or a guarded write refused after the evaluation window (spec 12). */
export class LicenceError extends MoggingError {
  declare readonly code: LicenceErrorCode;
  constructor(code: LicenceErrorCode, message: string) { super(code, message); }
}
