import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  /**
   * `suppressEnvelopeFor` lets a foreign-protocol adapter (the ABS API) opt its routes out of
   * BookOrbit's JSON error envelope. When it matches the request URL, the filter replies with a bare
   * status and empty body — the shape unmatched ABS routes need (see abs-route-rewrite.util.ts).
   */
  constructor(private readonly suppressEnvelopeFor?: (url: string) => boolean) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const exc = exception as Record<string, unknown> | undefined;

    if (exc?.code === 'ERR_STREAM_PREMATURE_CLOSE') {
      return;
    }

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : typeof exc?.statusCode === 'number'
          ? Number(exc.statusCode)
          : HttpStatus.INTERNAL_SERVER_ERROR;

    const raw = exception instanceof HttpException ? exception.getResponse() : 'Internal server error';
    const rawObject = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
    const message = typeof raw === 'string' ? raw : ((rawObject?.message as string) ?? (exc?.message as string) ?? 'An error occurred');
    const errorCode = typeof rawObject?.errorCode === 'string' ? rawObject.errorCode : undefined;

    if (status >= (HttpStatus.INTERNAL_SERVER_ERROR as number)) {
      this.logger.error(exception);
    }

    if (reply.sent) {
      return;
    }

    if (this.suppressEnvelopeFor?.(request.url)) {
      reply.status(status).send();
      return;
    }

    reply.status(status).send({
      statusCode: status,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
      requestId: request.id,
      ...(errorCode ? { errorCode } : {}),
    });
  }
}
