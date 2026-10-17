/** Raised when a uniqueness constraint would be violated. */
export class DuplicateError extends Error {
  constructor(
    public readonly field: string,
    value: string,
  ) {
    super(`Duplicate ${field}: ${value}`);
    this.name = 'DuplicateError';
  }
}

/** Raised when a requested record does not exist. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Raised when the caller is authenticated but lacks the required role. */
export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Raised when there is no valid authenticated session. */
export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** Raised when user-supplied input fails validation. */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}
