import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { AbsHttpException } from './abs-errors';

/**
 * Controller-scoped filter for the ABS adapter. Emits ABS-shaped errors and, crucially, never
 * leaks BookOrbit's `{ statusCode, message, ... }` envelope — ABS clients branch on status (and
 * occasionally a `{ error }` body), so a foreign envelope breaks them (REIMPLEMENTATION_GUIDE §4.4).
 *
 * Applied via `@UseFilters(AbsExceptionFilter)` on ABS controllers; controller-scoped filters take
 * precedence over the global `GlobalExceptionFilter`.
 */
@Catch()
export class AbsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AbsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const exc = exception as Record<string, unknown> | undefined;

    if (exc?.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    if (reply.sent) return;

    if (exception instanceof AbsHttpException) {
      this.sendAbs(reply, exception);
      return;
    }

    // Any other HttpException (e.g. a Nest built-in thrown by a reused service) collapses to a
    // bare status; unknown errors are logged and reported as a bare 500.
    if (exception instanceof HttpException) {
      reply.status(exception.getStatus()).send();
      return;
    }

    this.logger.error(exception);
    reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send();
  }

  private sendAbs(reply: FastifyReply, exception: AbsHttpException): void {
    const status = exception.getStatus();
    const body = exception.getResponse();
    switch (exception.shape) {
      case 'text':
        reply
          .status(status)
          .type('text/plain')
          .send(typeof body === 'string' ? body : '');
        return;
      case 'json':
        reply.status(status).send(body);
        return;
      case 'bare':
      default:
        reply.status(status).send();
        return;
    }
  }
}
