import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb, schema } from '../../db/index.js';
import { eq, and, isNull, desc, sql, inArray, gte } from 'drizzle-orm';
import type { ServiceContainer } from '../../index.js';
import { logger } from '../../lib/logger.js';
import { withLlmContext } from '../../lib/llm-tracker.js';

const createListBody = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(['company', 'contact', 'mixed']).default('contact'),
  icpId: z.string().uuid().optional(),
  personaId: z.string().uuid().optional(),
});

const updateScheduleBody = z.object({
  refreshEnabled: z.boolean(),
  refreshCron: z.string().optional(),
});

const buildBody = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
  skipExistingDb: z.boolean().optional(),
  providerOrder: z.array(z.string()).optional(),
});

export const listRoutes: FastifyPluginAsync<{ container: ServiceContainer }> = async (app, opts) => {
  // GET /api/lists
  app.get<{ Querystring: { clientId?: string } }>('/', async (request) => {
    const db = getDb();
    const conditions = [eq(schema.lists.isActive, true)];
    if (request.query.clientId) {
      conditions.push(eq(schema.lists.clientId, request.query.clientId));
    }
    const lists = await db.select().from(schema.lists).where(and(...conditions));
    return { data: lists };
  });

  // GET /api/lists/providers — return provider names that support company_search, in priority order
  app.get('/providers', async () => {
    const providers = opts.container.orchestrator.getProvidersByCapability('company_search');
    return { data: providers };
  });

  // GET /api/lists/:id
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const db = getDb();
    const [list] = await db.select().from(schema.lists).where(eq(schema.lists.id, request.params.id));
    if (!list) return reply.status(404).send({ error: 'List not found' });
    return { data: list };
  });

  // POST /api/lists
  app.post('/', async (request, reply) => {
    const body = createListBody.parse(request.body);
    const db = getDb();
    const [list] = await db.insert(schema.lists).values(body).returning();
    return reply.status(201).send({ data: list });
  });

  // POST /api/lists/:id/build
  app.post<{ Params: { id: string } }>('/:id/build', async (request, reply) => {
    const buildOptions = buildBody.parse(request.body ?? {});
    const db = getDb();
    const [list] = await db.select().from(schema.lists).where(eq(schema.lists.id, request.params.id));
    if (!list || !list.icpId) {
      return reply.status(400).send({ error: 'List not found or has no ICP assigned' });
    }

    // Create a job to track progress
    const [job] = await db
      .insert(schema.jobs)
      .values({
        clientId: list.clientId,
        type: 'list_build',
        status: 'pending',
        input: { listId: list.id, icpId: list.icpId, personaId: list.personaId },
      })
      .returning();

    // Kick off build in background (fire-and-forget)
    withLlmContext({ clientId: list.clientId, jobId: job.id }, () =>
      opts.container.listBuilder
        .buildListWithDiscovery({
          clientId: list.clientId,
          listId: list.id,
          icpId: list.icpId!,
          personaId: list.personaId ?? undefined,
          jobId: job.id,
          limit: buildOptions.limit,
          skipExistingDb: buildOptions.skipExistingDb,
          providerOrder: buildOptions.providerOrder,
        })
    ).catch(async (error) => {
        logger.error({ error, listId: list.id, jobId: job.id }, 'List build with discovery failed');
        await db
          .update(schema.jobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            updatedAt: new Date(),
            errors: [{ item: list.id, error: String(error), timestamp: new Date().toISOString() }],
          })
          .where(eq(schema.jobs.id, job.id));
      });

    return reply.status(202).send({ data: { jobId: job.id } });
  });

  // GET /api/lists/:id/build-status
  app.get<{ Params: { id: string } }>('/:id/build-status', async (request, reply) => {
    const db = getDb();
    const listId = request.params.id;

    // Look for any job associated with this list
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(and(
        inArray(schema.jobs.type, ['list_build', 'contact_list_build', 'persona_signal_detection', 'company_signals', 'brief_generation', 'market_signal_search']),
        sql`(${schema.jobs.input}->>'listId' = ${listId} OR ${schema.jobs.input}->>'contactListId' = ${listId})`,
      ))
      .orderBy(desc(schema.jobs.createdAt))
      .limit(1);

    if (!job) {
      return reply.status(404).send({ error: 'No build job found for this list' });
    }

    return { data: job };
  });

  // POST /api/lists/:id/refresh
  app.post<{ Params: { id: string } }>('/:id/refresh', async (request) => {
    await opts.container.listBuilder.refreshList(request.params.id);
    return { data: { refreshed: true } };
  });

  // PATCH /api/lists/:id/schedule
  app.patch<{ Params: { id: string } }>('/:id/schedule', async (request) => {
    const body = updateScheduleBody.parse(request.body);
    const db = getDb();

    await db
      .update(schema.lists)
      .set({
        refreshEnabled: body.refreshEnabled,
        refreshCron: body.refreshCron,
        updatedAt: new Date(),
      })
      .where(eq(schema.lists.id, request.params.id));

    await opts.container.scheduler.updateListSchedule(
      request.params.id,
      body.refreshEnabled ? (body.refreshCron ?? null) : null,
    );

    return { data: { updated: true } };
  });

  // GET /api/lists/:id/members
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string; stage?: string } }>(
    '/:id/members',
    async (request) => {
      const db = getDb();
      const limit = parseInt(request.query.limit ?? '50', 10);
      const offset = parseInt(request.query.offset ?? '0', 10);

      const conditions = [
        eq(schema.listMembers.listId, request.params.id),
        isNull(schema.listMembers.removedAt),
      ];

      // Filter by pipeline stage if provided
      const validStages = ['tam', 'active_segment', 'qualified', 'ready_to_approach', 'in_sequence', 'converted'] as const;
      if (request.query.stage && validStages.includes(request.query.stage as typeof validStages[number])) {
        conditions.push(eq(schema.listMembers.pipelineStage, request.query.stage as typeof validStages[number]));
      }

      const members = await db
        .select({
          id: schema.listMembers.id,
          companyId: schema.listMembers.companyId,
          contactId: schema.listMembers.contactId,
          icpFitScore: schema.listMembers.icpFitScore,
          companySignalScore: schema.companies.signalScore,
          signalScore: schema.listMembers.signalScore,
          intelligenceScore: schema.listMembers.intelligenceScore,
          personaScore: schema.listMembers.personaScore,
          addedReason: schema.listMembers.addedReason,
          addedAt: schema.listMembers.addedAt,
          companyName: schema.companies.name,
          companyDomain: schema.companies.domain,
          companyIndustry: schema.companies.industry,
          companySource: schema.companies.primarySource,
          companyWebsiteProfile: schema.companies.websiteProfile,
          pipelineStage: schema.listMembers.pipelineStage,
          contactName: schema.contacts.fullName,
          contactTitle: schema.contacts.title,
          contactEmail: schema.contacts.workEmail,
          engagementBrief: schema.listMembers.engagementBrief,
          briefGeneratedAt: schema.listMembers.briefGeneratedAt,
        })
        .from(schema.listMembers)
        .leftJoin(schema.companies, eq(schema.listMembers.companyId, schema.companies.id))
        .leftJoin(schema.contacts, eq(schema.listMembers.contactId, schema.contacts.id))
        .where(and(...conditions))
        .limit(limit)
        .offset(offset);

      return { data: members };
    },
  );

  // GET /api/lists/:id/member-signals — company signals for all list members, with linked market signal data
  app.get<{ Params: { id: string }; Querystring: { clientId: string } }>(
    '/:id/member-signals',
    async (request) => {
      const db = getDb();
      const now = new Date();

      // Get all company IDs in this list
      const memberRows = await db
        .select({ companyId: schema.listMembers.companyId })
        .from(schema.listMembers)
        .where(and(
          eq(schema.listMembers.listId, request.params.id),
          isNull(schema.listMembers.removedAt),
        ));

      const companyIds = memberRows
        .map(r => r.companyId)
        .filter((id): id is string => id !== null);

      if (companyIds.length === 0) return { data: [] };

      // Get all active company signals for these companies
      const signals = await db
        .select()
        .from(schema.companySignals)
        .where(and(
          inArray(schema.companySignals.companyId, companyIds),
          eq(schema.companySignals.clientId, request.query.clientId),
          gte(schema.companySignals.expiresAt, now),
        ));

      // For market_signal type signals, fetch the linked market signal records
      const marketSignalIds = signals
        .filter(s => s.signalType === 'market_signal')
        .map(s => (s.signalData as { details?: { marketSignalId?: string } })?.details?.marketSignalId)
        .filter((id): id is string => !!id);

      const uniqueMarketSignalIds = [...new Set(marketSignalIds)];

      let marketSignalMap: Record<string, { headline: string; sourceUrl: string | null; sourceName: string | null; signalCategory: string | null; summary: string | null }> = {};

      if (uniqueMarketSignalIds.length > 0) {
        const marketSignals = await db
          .select({
            id: schema.marketSignals.id,
            headline: schema.marketSignals.headline,
            sourceUrl: schema.marketSignals.sourceUrl,
            sourceName: schema.marketSignals.sourceName,
            signalCategory: schema.marketSignals.signalCategory,
            summary: schema.marketSignals.summary,
          })
          .from(schema.marketSignals)
          .where(inArray(schema.marketSignals.id, uniqueMarketSignalIds));

        for (const ms of marketSignals) {
          marketSignalMap[ms.id] = {
            headline: ms.headline,
            sourceUrl: ms.sourceUrl,
            sourceName: ms.sourceName,
            signalCategory: ms.signalCategory,
            summary: ms.summary,
          };
        }
      }

      // Enrich signals with market signal data
      const enriched = signals.map(s => {
        const details = (s.signalData as { details?: { marketSignalId?: string } })?.details;
        const msId = details?.marketSignalId;
        const marketSignal = msId ? marketSignalMap[msId] : undefined;

        return {
          ...s,
          marketSignal: marketSignal ?? null,
        };
      });

      return { data: enriched };
    },
  );

  // GET /api/lists/:id/contact-signals — persona signals for all contacts in a contact list
  app.get<{ Params: { id: string }; Querystring: { clientId: string } }>(
    '/:id/contact-signals',
    async (request) => {
      const db = getDb();
      const now = new Date();

      // Get all contact IDs in this list
      const memberRows = await db
        .select({ contactId: schema.listMembers.contactId })
        .from(schema.listMembers)
        .where(and(
          eq(schema.listMembers.listId, request.params.id),
          isNull(schema.listMembers.removedAt),
        ));

      const contactIds = memberRows
        .map(r => r.contactId)
        .filter((id): id is string => id !== null);

      if (contactIds.length === 0) return { data: [] };

      const signals = await db
        .select()
        .from(schema.contactSignals)
        .where(and(
          inArray(schema.contactSignals.contactId, contactIds),
          eq(schema.contactSignals.clientId, request.query.clientId),
          gte(schema.contactSignals.expiresAt, now),
        ));

      const FIT_TYPES = new Set(['title_match', 'seniority_match']);
      const enriched = signals.map(s => ({
        ...s,
        category: FIT_TYPES.has(s.signalType) ? 'fit' as const : 'signal' as const,
      }));

      return { data: enriched };
    },
  );

  // GET /api/lists/:id/funnel — pipeline stage counts for funnel view
  app.get<{ Params: { id: string } }>('/:id/funnel', async (request) => {
    const db = getDb();

    // Check list type — only exclude contact members for company lists
    const [list] = await db
      .select({ type: schema.lists.type })
      .from(schema.lists)
      .where(eq(schema.lists.id, request.params.id));

    const conditions = [
      eq(schema.listMembers.listId, request.params.id),
      isNull(schema.listMembers.removedAt),
    ];
    // For company lists, only count company-level members (exclude contact rows)
    if (list?.type !== 'contact') {
      conditions.push(isNull(schema.listMembers.contactId));
    }

    const rows = await db
      .select({
        stage: schema.listMembers.pipelineStage,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.listMembers)
      .where(and(...conditions))
      .groupBy(schema.listMembers.pipelineStage);

    const stages: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      stages[row.stage] = row.count;
      total += row.count;
    }

    return { data: { stages, total } };
  });

  // POST /api/lists/:id/build-contacts — build a contact list from qualified companies
  app.post<{ Params: { id: string } }>('/:id/build-contacts', async (request, reply) => {
    const body = z.object({
      personaId: z.string().uuid(),
      name: z.string().min(1).optional(),
    }).parse(request.body);

    const db = getDb();
    const [sourceList] = await db.select().from(schema.lists).where(eq(schema.lists.id, request.params.id));
    if (!sourceList) {
      return reply.status(404).send({ error: 'Source list not found' });
    }
    if (sourceList.type !== 'company') {
      return reply.status(400).send({ error: 'Can only build contacts from a company list' });
    }

    // Create the contact list linked to this source list
    const [contactList] = await db
      .insert(schema.lists)
      .values({
        clientId: sourceList.clientId,
        icpId: sourceList.icpId,
        personaId: body.personaId,
        name: body.name ?? `${sourceList.name} — Contacts`,
        type: 'contact',
        sourceCompanyListId: sourceList.id,
      })
      .returning();

    // Create a job to track progress
    const [job] = await db
      .insert(schema.jobs)
      .values({
        clientId: sourceList.clientId,
        type: 'contact_list_build',
        status: 'running',
        input: { sourceListId: sourceList.id, contactListId: contactList.id, personaId: body.personaId },
      })
      .returning();

    // Fire-and-forget
    reply.status(202).send({ data: { jobId: job.id, contactListId: contactList.id } });

    withLlmContext({ clientId: sourceList.clientId, jobId: job.id }, () =>
      opts.container.listBuilder
        .buildContactList({
          clientId: sourceList.clientId,
          sourceListId: sourceList.id,
          contactListId: contactList.id,
          personaId: body.personaId,
        })
    ).then(async (result) => {
        await db
          .update(schema.jobs)
          .set({
            status: 'completed',
            processedItems: result.contactsAdded,
            output: result,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.jobs.id, job.id));
      })
      .catch(async (error) => {
        logger.error({ error, jobId: job.id }, 'Contact list build failed');
        await db
          .update(schema.jobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            updatedAt: new Date(),
            errors: [{ item: contactList.id, error: String(error), timestamp: new Date().toISOString() }],
          })
          .where(eq(schema.jobs.id, job.id));
      });
  });

  // POST /api/lists/:id/signals/persona — run persona signal detection on contact list
  app.post<{ Params: { id: string } }>('/:id/signals/persona', async (request, reply) => {
    const db = getDb();
    const [list] = await db.select().from(schema.lists).where(eq(schema.lists.id, request.params.id));
    if (!list) {
      return reply.status(404).send({ error: 'List not found' });
    }
    if (list.type !== 'contact') {
      return reply.status(400).send({ error: 'Persona signals can only be run on contact lists' });
    }
    if (!list.personaId) {
      return reply.status(400).send({ error: 'List has no persona assigned' });
    }

    // Create a job to track progress
    const [job] = await db
      .insert(schema.jobs)
      .values({
        clientId: list.clientId,
        type: 'persona_signal_detection',
        status: 'running',
        input: { listId: list.id, personaId: list.personaId },
      })
      .returning();

    // Fire-and-forget
    reply.status(202).send({ data: { jobId: job.id } });

    withLlmContext({ clientId: list.clientId, jobId: job.id }, () =>
      opts.container.listBuilder
        .runPersonaSignals(list.id)
    ).then(async (result) => {
        await db
          .update(schema.jobs)
          .set({
            status: 'completed',
            processedItems: result.processed,
            output: result,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.jobs.id, job.id));
      })
      .catch(async (error) => {
        logger.error({ error, listId: list.id, jobId: job.id }, 'Persona signal detection failed');
        await db
          .update(schema.jobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            updatedAt: new Date(),
            errors: [{ item: list.id, error: String(error), timestamp: new Date().toISOString() }],
          })
          .where(eq(schema.jobs.id, job.id));
      });
  });

  // POST /api/lists/:id/generate-briefs — generate engagement briefs for qualifying contacts
  app.post<{ Params: { id: string } }>('/:id/generate-briefs', async (request, reply) => {
    const body = z.object({
      forceRegenerate: z.boolean().optional(),
    }).parse(request.body ?? {});

    const db = getDb();
    const [list] = await db.select().from(schema.lists).where(eq(schema.lists.id, request.params.id));
    if (!list) {
      return reply.status(404).send({ error: 'List not found' });
    }
    if (list.type !== 'contact') {
      return reply.status(400).send({ error: 'Briefs can only be generated for contact lists' });
    }

    const [job] = await db
      .insert(schema.jobs)
      .values({
        clientId: list.clientId,
        type: 'brief_generation',
        status: 'running',
        input: { listId: list.id, forceRegenerate: body.forceRegenerate ?? false },
      })
      .returning();

    reply.status(202).send({ data: { jobId: job.id } });

    withLlmContext({ clientId: list.clientId, jobId: job.id }, () =>
      opts.container.listBuilder
        .generateBriefs(list.id, {
          forceRegenerate: body.forceRegenerate,
        })
    ).then(async (result) => {
        await db
          .update(schema.jobs)
          .set({
            status: 'completed',
            processedItems: result.generated,
            output: result as unknown as Record<string, unknown>,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.jobs.id, job.id));
      })
      .catch(async (error) => {
        logger.error({ error, listId: list.id, jobId: job.id }, 'Brief generation failed');
        await db
          .update(schema.jobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            updatedAt: new Date(),
            errors: [{ item: list.id, error: String(error), timestamp: new Date().toISOString() }],
          })
          .where(eq(schema.jobs.id, job.id));
      });
  });

  // POST /api/lists/:id/deep-enrich — scrape websites and generate PESTLE profiles
  app.post<{ Params: { id: string } }>('/:id/deep-enrich', async (request, reply) => {
    const db = getDb();
    const [list] = await db.select().from(schema.lists).where(eq(schema.lists.id, request.params.id));
    if (!list) {
      return reply.status(404).send({ error: 'List not found' });
    }
    if (!opts.container.deepEnrichmentService) {
      return reply.status(503).send({ error: 'Deep enrichment not configured (missing Jina API key)' });
    }

    // Get company IDs from list members
    const members = await db
      .select({ companyId: schema.listMembers.companyId })
      .from(schema.listMembers)
      .where(and(
        eq(schema.listMembers.listId, list.id),
        isNull(schema.listMembers.removedAt),
      ));

    const companyIds = members.map(m => m.companyId).filter((id): id is string => id != null);
    if (companyIds.length === 0) {
      return reply.status(400).send({ error: 'List has no company members' });
    }

    // Create a job
    const [job] = await db
      .insert(schema.jobs)
      .values({
        clientId: list.clientId,
        type: 'deep_enrichment',
        status: 'running',
        input: { listId: list.id, companyCount: companyIds.length },
      })
      .returning();

    reply.status(202).send({ data: { jobId: job.id } });

    withLlmContext({ clientId: list.clientId, jobId: job.id }, () =>
      opts.container.deepEnrichmentService!
        .enrichBatch(list.clientId, companyIds, { jobId: job.id })
    ).then(async (result) => {
        await db
          .update(schema.jobs)
          .set({
            status: 'completed',
            processedItems: result.profiled,
            output: result as unknown as Record<string, unknown>,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.jobs.id, job.id));
      })
      .catch(async (error) => {
        logger.error({ error, listId: list.id, jobId: job.id }, 'Deep enrichment failed');
        await db
          .update(schema.jobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            updatedAt: new Date(),
            errors: [{ item: list.id, error: String(error), timestamp: new Date().toISOString() }],
          })
          .where(eq(schema.jobs.id, job.id));
      });
  });

  // POST /api/lists/:id/apply-market-signals — full pipeline: deep-enrich → search evidence → classify + promote
  app.post<{ Params: { id: string } }>('/:id/apply-market-signals', async (request, reply) => {
    const db = getDb();
    const [list] = await db.select().from(schema.lists).where(eq(schema.lists.id, request.params.id));
    if (!list) {
      return reply.status(404).send({ error: 'List not found' });
    }

    // Get company IDs from list members
    const members = await db
      .select({ companyId: schema.listMembers.companyId })
      .from(schema.listMembers)
      .where(and(
        eq(schema.listMembers.listId, list.id),
        isNull(schema.listMembers.removedAt),
      ));

    const companyIds = members.map(m => m.companyId).filter((id): id is string => id != null);
    if (companyIds.length === 0) {
      return reply.status(400).send({ error: 'List has no company members' });
    }

    // Pre-flight: check that active market hypotheses exist
    const [hypothesisCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.signalHypotheses)
      .where(and(
        eq(schema.signalHypotheses.clientId, list.clientId),
        eq(schema.signalHypotheses.signalLevel, 'market'),
        eq(schema.signalHypotheses.status, 'active'),
      ));
    if (!hypothesisCount || hypothesisCount.count === 0) {
      return reply.status(400).send({
        error: 'No active market hypotheses found. Generate hypotheses first before applying market signals.',
      });
    }

    // Parse options from request body
    const body = request.body as { forceFresh?: boolean } | undefined;
    const forceFresh = body?.forceFresh === true;

    // Create a job to track the composite pipeline
    const [job] = await db
      .insert(schema.jobs)
      .values({
        clientId: list.clientId,
        type: 'market_signal_search',
        status: 'running',
        input: { listId: list.id, pipeline: 'apply_market_signals' },
      })
      .returning();

    // Set totalItems so the UI can show a progress bar (3 steps)
    await db
      .update(schema.jobs)
      .set({ totalItems: 3, processedItems: 0, startedAt: new Date() })
      .where(eq(schema.jobs.id, job.id));

    reply.status(202).send({ data: { jobId: job.id } });

    // Run the full pipeline in background
    withLlmContext({ clientId: list.clientId, jobId: job.id }, async () => {
      const log = logger.child({ listId: list.id, jobId: job.id });
      const output: Record<string, unknown> = {};

      // Helper to update job progress
      const updateProgress = async (step: number, stepLabel: string) => {
        await db
          .update(schema.jobs)
          .set({
            processedItems: step,
            output: { ...output, currentStep: stepLabel },
            updatedAt: new Date(),
          })
          .where(eq(schema.jobs.id, job.id));
      };

      try {
        // Step 1: Deep enrich unprofiled companies
        if (opts.container.deepEnrichmentService) {
          log.info('Step 1/3: Deep enrichment');
          await updateProgress(0, 'Deep enrichment — profiling company websites');
          const enrichResult = await opts.container.deepEnrichmentService.enrichBatch(
            list.clientId, companyIds, { jobId: job.id },
          );
          output.enrichment = enrichResult;
          log.info(enrichResult, 'Deep enrichment complete');
        } else {
          output.enrichment = { skipped: true, reason: 'No Jina API key configured' };
        }
        await updateProgress(1, 'Deep enrichment complete');

        // Step 2: Search for evidence from active hypotheses
        if (opts.container.marketSignalSearcher) {
          log.info('Step 2/3: Evidence search');
          await updateProgress(1, 'Searching for market signal evidence');
          const searchResult = await opts.container.marketSignalSearcher.searchForEvidence(
            list.clientId,
            { cooldownHours: forceFresh ? 0 : undefined },
          );
          output.evidenceSearch = searchResult;
          log.info(searchResult, 'Evidence search complete');
        } else {
          output.evidenceSearch = { skipped: true, reason: 'No search providers configured' };
        }
        await updateProgress(2, 'Evidence search complete');

        // Step 3: Classify unprocessed signals + promote matching companies
        log.info('Step 3/3: Signal classification + promotion');
        await updateProgress(2, 'Classifying signals and promoting companies');
        const processedCount = await opts.container.marketSignalProcessor.processUnclassifiedSignals(list.clientId);
        output.classification = { processedCount };
        log.info({ processedCount }, 'Signal classification complete');

        delete output.currentStep;
        await db
          .update(schema.jobs)
          .set({
            status: 'completed',
            processedItems: 3,
            output,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.jobs.id, job.id));

        log.info(output, 'Apply market signals pipeline complete');
      } catch (error) {
        log.error({ error }, 'Apply market signals pipeline failed');
        await db
          .update(schema.jobs)
          .set({
            status: 'failed',
            output: { ...output, currentStep: 'Failed' },
            completedAt: new Date(),
            updatedAt: new Date(),
            errors: [{ item: list.id, error: String(error), timestamp: new Date().toISOString() }],
          })
          .where(eq(schema.jobs.id, job.id));
      }
    });
  });

  // POST /api/lists/:id/signals/company — trigger company-level signal detection
  app.post<{ Params: { id: string } }>('/:id/signals/company', async (request, reply) => {
    const db = getDb();
    const [list] = await db.select().from(schema.lists).where(eq(schema.lists.id, request.params.id));
    if (!list) {
      return reply.status(404).send({ error: 'List not found' });
    }

    // Create a job to track progress
    const [job] = await db
      .insert(schema.jobs)
      .values({
        clientId: list.clientId,
        type: 'company_signals',
        status: 'pending',
        input: { listId: list.id },
      })
      .returning();

    // Run company signals in background
    withLlmContext({ clientId: list.clientId, jobId: job.id }, () =>
      opts.container.listBuilder
        .runCompanySignals(list.id)
    ).then(async (result) => {
        await db
          .update(schema.jobs)
          .set({
            status: 'completed',
            completedAt: new Date(),
            updatedAt: new Date(),
            output: result,
          })
          .where(eq(schema.jobs.id, job.id));
      })
      .catch(async (error) => {
        logger.error({ error, listId: list.id, jobId: job.id }, 'Company signal detection failed');
        await db
          .update(schema.jobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            updatedAt: new Date(),
            errors: [{ item: list.id, error: String(error), timestamp: new Date().toISOString() }],
          })
          .where(eq(schema.jobs.id, job.id));
      });

    return reply.status(202).send({ data: { jobId: job.id } });
  });

  // DELETE /api/lists/:id — soft-delete a list
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const db = getDb();
    const [list] = await db.select().from(schema.lists).where(eq(schema.lists.id, request.params.id));
    if (!list) {
      return reply.status(404).send({ error: 'List not found' });
    }

    await db
      .update(schema.lists)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(schema.lists.id, request.params.id));

    // Also soft-delete any child contact lists that were built from this company list
    if (list.type === 'company') {
      await db
        .update(schema.lists)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(schema.lists.sourceCompanyListId, list.id));
    }

    return { success: true };
  });
};
