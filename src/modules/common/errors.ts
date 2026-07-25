export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', 422, details);
    this.name = 'ValidationError';
  }
}

export class NotImplementedError extends AppError {
  constructor(message = 'This capability is not implemented yet') {
    super(message, 'NOT_IMPLEMENTED', 501);
    this.name = 'NotImplementedError';
  }
}

/** Raised when the simulated external gateway does not respond in time. */
export class GatewayTimeoutError extends AppError {
  constructor(message = 'Gateway request timed out') {
    super(message, 'GATEWAY_TIMEOUT', 504);
    this.name = 'GatewayTimeoutError';
  }
}
