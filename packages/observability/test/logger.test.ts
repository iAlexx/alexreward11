import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { createShutdownCoordinator, parseOtlpHeaders } from '../src/index.js';

describe('structured logging safeguard', () => {
  it('redacts authentication material', async () => {
    let output = '';
    const destination = new Writable({
      write(chunk: unknown, _encoding, callback) {
        output += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
        callback();
      },
    });
    const logger = pino({ redact: ['authorization', 'token'] }, destination);
    logger.info({ authorization: 'Bearer secret-value', token: 'secret-token' }, 'test');
    await new Promise<void>((resolve) => destination.end(resolve));
    expect(output).not.toContain('secret-value');
    expect(output).not.toContain('secret-token');
    expect(JSON.parse(output)).toMatchObject({ authorization: '[Redacted]', token: '[Redacted]' });
  });
});

describe('shutdown coordinator', () => {
  it('runs cleanup steps once when signals race', async () => {
    const step = vi.fn(async () => undefined);
    const logger = pino({ enabled: false });
    const shutdown = createShutdownCoordinator(logger, 'test-service', [step]);
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(step).toHaveBeenCalledTimes(1);
  });
});

describe('OTLP header parsing', () => {
  it('parses and decodes standard OTLP header syntax', () => {
    expect(parseOtlpHeaders('Authorization=Basic%20YWJjZA%3D%3D')).toEqual({
      Authorization: 'Basic YWJjZA==',
    });
  });

  it('rejects malformed header entries without a key/value separator', () => {
    expect(() => parseOtlpHeaders('not-a-header')).toThrow(/OTEL_EXPORTER_OTLP_HEADERS/);
  });
});
