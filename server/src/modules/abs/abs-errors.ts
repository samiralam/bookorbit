import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * ABS has no uniform error envelope (REIMPLEMENTATION_GUIDE §4.4): handlers variously reply with a
 * bare status, a plain-text body, or `{ error }` JSON, and some admin reads deliberately return 404
 * instead of 403. ABS controllers throw these so `AbsExceptionFilter` can emit the exact wire shape
 * the endpoint requires, rather than BookOrbit's `{ statusCode, message, ... }` envelope.
 */
export type AbsErrorShape = 'bare' | 'text' | 'json';

export class AbsHttpException extends HttpException {
  readonly shape: AbsErrorShape;

  private constructor(status: number, body: string | Record<string, unknown>, shape: AbsErrorShape) {
    super(body, status);
    this.shape = shape;
  }

  /** Empty-body status response (the most common ABS error form). */
  static bare(status: number): AbsHttpException {
    return new AbsHttpException(status, '', 'bare');
  }

  /** `res.status(x).send("message")` — plain text. */
  static text(status: number, message: string): AbsHttpException {
    return new AbsHttpException(status, message, 'text');
  }

  /** `res.status(x).json({ error })` — used by the auth routes. */
  static json(status: number, body: Record<string, unknown>): AbsHttpException {
    return new AbsHttpException(status, body, 'json');
  }

  static unauthorized(): AbsHttpException {
    return AbsHttpException.bare(HttpStatus.UNAUTHORIZED);
  }

  static notFound(): AbsHttpException {
    return AbsHttpException.bare(HttpStatus.NOT_FOUND);
  }

  static forbidden(): AbsHttpException {
    return AbsHttpException.bare(HttpStatus.FORBIDDEN);
  }
}
