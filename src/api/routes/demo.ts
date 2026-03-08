import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createHash } from 'crypto';
import type { ServiceContainer } from '../../index.js';
import { config } from '../../config/index.js';
import { DemoError } from '../../services/demo/index.js';
import { DEMO_INDUSTRIES } from '../../services/demo/industry-config.js';

const signalsBody = z.object({
  industry: z.string().min(1).max(100),
});

const discoveryBody = z.object({
  icp: z.string().min(10, 'ICP description must be at least 10 characters').max(500),
  signal: z.string().min(3, 'Signal description must be at least 3 characters').max(300),
});

const buzzBody = z.object({
  industry: z.string().min(1).max(100),
});

function hashIp(request: { headers: Record<string, string | string[] | undefined>; ip: string }): string {
  const forwarded = request.headers['x-forwarded-for'];
  const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined)
    ?? (request.headers['x-real-ip'] as string | undefined)
    ?? request.ip;
  return createHash('sha256').update(ip).digest('hex');
}

export const demoRoutes: FastifyPluginAsync<{ container: ServiceContainer }> = async (app, opts) => {
  const { demoService } = opts.container;

  // If demo service is not configured, return 503 on all demo routes
  if (!demoService) {
    app.all('/*', async (_req, reply) =>
      reply.status(503).send({ error: 'Demo service not configured' }),
    );
    return;
  }

  // Demo-specific auth via x-api-key header
  app.addHook('onRequest', async (request, reply) => {
    const apiKey = request.headers['x-api-key'] as string | undefined;
    if (!apiKey || apiKey !== config.apiKey) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  // ── POST /api/demo/signals ──

  app.post('/signals', async (request, reply) => {
    const startMs = Date.now();
    const ipHash = hashIp(request);
    let statusCode = 200;

    try {
      const body = signalsBody.parse(request.body);

      // Rate limit
      const limit = demoService.checkRateLimit(ipHash);
      if (!limit.allowed) {
        statusCode = 429;
        reply.header('Retry-After', String(limit.retryAfterSeconds ?? 3600));
        return reply.status(429).send({ error: limit.reason });
      }

      const signals = await demoService.handleSignals(body.industry, ipHash);
      return { signals };
    } catch (error) {
      if (error instanceof DemoError) {
        statusCode = error.statusCode;
        return reply.status(error.statusCode).send({ error: error.message });
      }
      if (error instanceof z.ZodError) {
        statusCode = 400;
        return reply.status(400).send({ error: 'Invalid request', details: error.flatten().fieldErrors });
      }
      throw error;
    } finally {
      demoService.logRequest({
        endpoint: 'signals',
        industry: (request.body as Record<string, unknown>)?.industry as string | undefined,
        ipHash,
        userAgent: request.headers['user-agent'],
        responseTimeMs: Date.now() - startMs,
        statusCode,
      });
    }
  });

  // ── POST /api/demo/discovery ──

  app.post('/discovery', async (request, reply) => {
    const startMs = Date.now();
    const ipHash = hashIp(request);
    let statusCode = 200;

    try {
      const body = discoveryBody.parse(request.body);

      // Rate limit
      const limit = demoService.checkRateLimit(ipHash);
      if (!limit.allowed) {
        statusCode = 429;
        reply.header('Retry-After', String(limit.retryAfterSeconds ?? 3600));
        return reply.status(429).send({ error: limit.reason });
      }

      const companies = await demoService.handleDiscovery(body.icp, body.signal, ipHash);
      return { companies };
    } catch (error) {
      if (error instanceof DemoError) {
        statusCode = error.statusCode;
        return reply.status(error.statusCode).send({ error: error.message });
      }
      if (error instanceof z.ZodError) {
        statusCode = 400;
        return reply.status(400).send({ error: 'Invalid request', details: error.flatten().fieldErrors });
      }
      throw error;
    } finally {
      const bodyObj = request.body as Record<string, unknown>;
      demoService.logRequest({
        endpoint: 'discovery',
        icpText: bodyObj?.icp as string | undefined,
        ipHash,
        userAgent: request.headers['user-agent'],
        responseTimeMs: Date.now() - startMs,
        statusCode,
      });
    }
  });

  // ── POST /api/demo/buzz ──

  app.post('/buzz', async (request, reply) => {
    const startMs = Date.now();
    const ipHash = hashIp(request);
    let statusCode = 200;

    try {
      const body = buzzBody.parse(request.body);

      // Rate limit
      const limit = demoService.checkRateLimit(ipHash);
      if (!limit.allowed) {
        statusCode = 429;
        reply.header('Retry-After', String(limit.retryAfterSeconds ?? 3600));
        return reply.status(429).send({ error: limit.reason });
      }

      const report = await demoService.handleBuzz(body.industry);
      return { report };
    } catch (error) {
      if (error instanceof DemoError) {
        statusCode = error.statusCode;
        return reply.status(error.statusCode).send({ error: error.message });
      }
      if (error instanceof z.ZodError) {
        statusCode = 400;
        return reply.status(400).send({ error: 'Invalid request', details: error.flatten().fieldErrors });
      }
      throw error;
    } finally {
      demoService.logRequest({
        endpoint: 'buzz',
        industry: (request.body as Record<string, unknown>)?.industry as string | undefined,
        ipHash,
        userAgent: request.headers['user-agent'],
        responseTimeMs: Date.now() - startMs,
        statusCode,
      });
    }
  });

  // ── GET /api/demo/industries ── (helper for the frontend)

  app.get('/industries', async () => {
    return {
      industries: Object.entries(DEMO_INDUSTRIES).map(([slug, config]) => ({
        slug,
        label: config.label,
      })),
    };
  });
};
