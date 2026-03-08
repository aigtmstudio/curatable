import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ServiceContainer } from '../../index.js';
import { logger } from '../../lib/logger.js';
import type { MarketBuilderPlan } from '../../services/intelligence/market-builder.js';

const generateBody = z.object({
  clientId: z.string().uuid(),
  icpId: z.string().uuid().optional(),
});

const refineBody = z.object({
  clientId: z.string().uuid(),
  plan: z.object({}).passthrough(),
  feedback: z.string().min(1),
});

const approveBody = z.object({
  clientId: z.string().uuid(),
  icpId: z.string().uuid().nullable().optional(),
  plan: z.object({}).passthrough(),
});

const buildBody = z.object({
  planId: z.string().uuid(),
  clientId: z.string().uuid(),
  listId: z.string().uuid().optional(),
});

const buildAutoBody = z.object({
  clientId: z.string().uuid(),
  listId: z.string().uuid().optional(),
});

export const marketBuilderRoutes: FastifyPluginAsync<{ container: ServiceContainer }> = async (app, opts) => {
  const log = logger.child({ route: 'market-builder' });
  const { marketBuilder } = opts.container;

  if (!marketBuilder) {
    app.all('/*', async (_req, reply) => reply.status(503).send({ error: 'Market builder service not configured' }));
    return;
  }

  // POST /api/market-builder/plan/generate
  // Generate a new plan for the client's active ICP. Returns draft plan — no DB write.
  app.post('/plan/generate', async (request, reply) => {
    const { clientId, icpId } = generateBody.parse(request.body);
    log.info({ clientId, icpId }, 'Generating market builder plan');

    const plan = await marketBuilder.generatePlan(clientId, icpId);
    return reply.send({ data: plan });
  });

  // POST /api/market-builder/plan/refine
  // Refine an existing plan based on user feedback. Returns updated plan — no DB write.
  app.post('/plan/refine', async (request, reply) => {
    const body = refineBody.parse(request.body);
    log.info({ clientId: body.clientId, feedback: body.feedback.substring(0, 80) }, 'Refining market builder plan');

    const plan = await marketBuilder.refinePlan(
      body.plan as unknown as MarketBuilderPlan,
      body.feedback,
      body.clientId,
    );
    return reply.send({ data: plan });
  });

  // POST /api/market-builder/plan/approve
  // Save an approved plan to DB. Archives any existing approved plan for this client/ICP.
  app.post('/plan/approve', async (request, reply) => {
    const body = approveBody.parse(request.body);
    log.info({ clientId: body.clientId, icpId: body.icpId }, 'Approving market builder plan');

    const saved = await marketBuilder.approvePlan(
      body.clientId,
      body.icpId ?? null,
      body.plan as unknown as MarketBuilderPlan,
    );
    return reply.status(201).send({ data: saved });
  });

  // GET /api/market-builder/plan?clientId=&icpId=
  // Fetch current approved plan for a client.
  app.get<{ Querystring: { clientId?: string; icpId?: string } }>('/plan', async (request, reply) => {
    const { clientId, icpId } = request.query;
    if (!clientId) return reply.status(400).send({ error: 'clientId is required' });

    const plan = await marketBuilder.getApprovedPlan(clientId, icpId);
    return reply.send({ data: plan });
  });

  // POST /api/market-builder/build
  // Execute an approved saved plan. Returns 202 immediately; runs async.
  app.post('/build', async (request, reply) => {
    const body = buildBody.parse(request.body);
    log.info({ planId: body.planId, clientId: body.clientId }, 'Market builder execution triggered');

    reply.status(202).send({ data: { message: 'Market build started' } });

    marketBuilder
      .executePlan(body.planId, body.clientId, body.listId)
      .then(result => log.info({ planId: body.planId, ...result }, 'Market build complete'))
      .catch(err => log.error({ err, planId: body.planId }, 'Market build failed'));
  });

  // POST /api/market-builder/build-auto
  // Generate plan + immediately execute, without user approval step.
  app.post('/build-auto', async (request, reply) => {
    const body = buildAutoBody.parse(request.body);
    log.info({ clientId: body.clientId }, 'Market builder auto-build triggered');

    reply.status(202).send({ data: { message: 'AI market build started' } });

    marketBuilder
      .generateAndExecute(body.clientId, body.listId)
      .then(({ plan, result }) => log.info({ clientId: body.clientId, vertical: plan.vertical, ...result }, 'AI market build complete'))
      .catch(err => log.error({ err, clientId: body.clientId }, 'AI market build failed'));
  });
};
