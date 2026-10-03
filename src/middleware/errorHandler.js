import { AppError, ValidationError } from '../shared/errors/AppError.js';

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const status = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';

  if (err.isJoi) {
    return res.status(422).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: err.details?.map((d) => ({ field: d.path.join('.'), message: d.message })),
      },
    });
  }

  if (err.name === 'ValidationError' && !err.statusCode) {
    return res.status(422).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: err.message,
        details: Object.values(err.errors || {}).map((e) => ({ field: e.path, message: e.message })),
      },
    });
  }

  if (err instanceof AppError) {
    return res.status(status).json({
      success: false,
      error: {
        code,
        message: err.message,
        details: err.details,
      },
    });
  }

  console.error(err);
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
}

export function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(
      { body: req.body, query: req.query, params: req.params },
      { abortEarly: false, allowUnknown: true }
    );
    if (error) return next(error);
    req.body = value.body ?? req.body;
    req.query = value.query ?? req.query;
    req.params = value.params ?? req.params;
    next();
  };
}
