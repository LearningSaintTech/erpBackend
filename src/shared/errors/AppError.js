export class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, 422, 'VALIDATION_ERROR', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, 409, 'CONFLICT');
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request') {
    super(message, 400, 'BAD_REQUEST');
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests. Please try again later.') {
    super(message, 429, 'RATE_LIMIT_EXCEEDED');
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable. Please try again later.') {
    super(message, 503, 'SERVICE_UNAVAILABLE');
  }
}

export class BadGatewayError extends AppError {
  constructor(message = 'Upstream service failed') {
    super(message, 502, 'BAD_GATEWAY');
  }
}
