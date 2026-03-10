import PgBoss from 'pg-boss';
import { getDb, schema } from '../../db/index.js';
import { eq, and, isNotNull, lt } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';

const STALE_JOB_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_JOB_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

export const JOB_TYPES = {
  LIST_REFRESH: 'list-refresh',
  ENRICHMENT: 'enrichment',
  EXPORT: 'export',
  MARKET_SIGNAL_PROCESSING: 'market-signal-processing',
  DEMO_SIGNAL_REFRESH: 'demo-signal-refresh',
  DEMO_BUZZ_PREGENERATE: 'demo-buzz-pregenerate',
} as const;

export class Scheduler {
  private boss: PgBoss;
  private staleJobTimer: ReturnType<typeof setInterval> | null = null;

  constructor(connectionString: string) {
    this.boss = new PgBoss({
      connectionString,
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInHours: 23,
      archiveCompletedAfterSeconds: 7 * 24 * 3600,
    });
  }

  async start(handlers: {
    onListRefresh: (data: { listId: string; clientId: string }) => Promise<void>;
    onEnrichment: (data: { clientId: string; domains: string[]; jobId: string; options?: Record<string, unknown> }) => Promise<void>;
    onExport: (data: { clientId: string; listId: string; format: string; destination?: Record<string, unknown> }) => Promise<void>;
    onMarketSignalProcessing?: (data: { clientId?: string; batchSize?: number }) => Promise<void>;
  }): Promise<void> {
    await this.boss.start();

    await this.boss.work(JOB_TYPES.LIST_REFRESH, async (jobs: PgBoss.Job[]) => {
      for (const job of jobs) {
        logger.info({ jobId: job.id, data: job.data }, 'Processing list refresh');
        await handlers.onListRefresh(job.data as { listId: string; clientId: string });
      }
    });

    await this.boss.work(JOB_TYPES.ENRICHMENT, async (jobs: PgBoss.Job[]) => {
      for (const job of jobs) {
        logger.info({ jobId: job.id }, 'Processing enrichment');
        await handlers.onEnrichment(job.data as { clientId: string; domains: string[]; jobId: string; options?: Record<string, unknown> });
      }
    });

    await this.boss.work(JOB_TYPES.EXPORT, async (jobs: PgBoss.Job[]) => {
      for (const job of jobs) {
        logger.info({ jobId: job.id }, 'Processing export');
        await handlers.onExport(job.data as { clientId: string; listId: string; format: string; destination?: Record<string, unknown> });
      }
    });

    // Market signal processing handler + schedule
    if (handlers.onMarketSignalProcessing) {
      await this.boss.createQueue(JOB_TYPES.MARKET_SIGNAL_PROCESSING);
      await this.boss.work(JOB_TYPES.MARKET_SIGNAL_PROCESSING, async (jobs: PgBoss.Job[]) => {
        for (const job of jobs) {
          logger.info({ jobId: job.id }, 'Processing market signals');
          await handlers.onMarketSignalProcessing!(job.data as { clientId?: string; batchSize?: number });
        }
      });

      // Schedule weekly (Sunday 2am) — on-demand processing via API remains available
      await this.boss.schedule(
        JOB_TYPES.MARKET_SIGNAL_PROCESSING,
        '0 2 * * 0',
        { batchSize: 50 },
      );
      logger.info('Market signal processing scheduled weekly (Sunday 2am)');
    }

    await this.registerListRefreshSchedules();

    // Start stale job reaper — auto-fails jobs stuck in "running" with no progress
    this.staleJobTimer = setInterval(() => this.reapStaleJobs(), STALE_JOB_CHECK_INTERVAL_MS);
    // Run once immediately on startup to catch jobs orphaned by a restart
    void this.reapStaleJobs();

    logger.info('Scheduler started');
  }

  async registerListRefreshSchedules(): Promise<void> {
    const db = getDb();
    const refreshableLists = await db
      .select()
      .from(schema.lists)
      .where(
        and(
          eq(schema.lists.refreshEnabled, true),
          eq(schema.lists.isActive, true),
          isNotNull(schema.lists.refreshCron),
        ),
      );

    for (const list of refreshableLists) {
      if (!list.refreshCron) continue;
      const scheduleName = `list-refresh-${list.id}`;
      await this.boss.schedule(scheduleName, list.refreshCron, {
        listId: list.id,
        clientId: list.clientId,
      });
      logger.info({ listId: list.id, cron: list.refreshCron }, 'Registered refresh schedule');
    }
  }

  async enqueue(type: string, data: Record<string, unknown>, options?: { priority?: number }): Promise<string> {
    const jobId = await this.boss.send(type, data, {
      priority: options?.priority ?? 0,
    });
    return jobId!;
  }

  async updateListSchedule(listId: string, cron: string | null): Promise<void> {
    const scheduleName = `list-refresh-${listId}`;
    await this.boss.unschedule(scheduleName);
    if (cron) {
      const db = getDb();
      const [list] = await db.select().from(schema.lists).where(eq(schema.lists.id, listId)).limit(1);
      if (list) {
        await this.boss.schedule(scheduleName, cron, {
          listId: list.id,
          clientId: list.clientId,
        });
      }
    }
  }

  async registerDemoJobs(handlers: {
    onSignalRefresh: () => Promise<void>;
    onBuzzPregenerate: () => Promise<void>;
  }, demoClientId: string): Promise<void> {
    await this.boss.work(JOB_TYPES.DEMO_SIGNAL_REFRESH, async (jobs: PgBoss.Job[]) => {
      for (const job of jobs) {
        logger.info({ jobId: job.id }, 'Running demo signal refresh');
        await handlers.onSignalRefresh();
      }
    });

    await this.boss.work(JOB_TYPES.DEMO_BUZZ_PREGENERATE, async (jobs: PgBoss.Job[]) => {
      for (const job of jobs) {
        logger.info({ jobId: job.id }, 'Running demo buzz pre-generation');
        await handlers.onBuzzPregenerate();
      }
    });

    // Daily at 05:30 UTC — refresh demo signals
    await this.boss.schedule(
      JOB_TYPES.DEMO_SIGNAL_REFRESH,
      '30 5 * * *',
      { clientId: demoClientId },
    );

    // Daily at 06:00 UTC — pre-generate buzz reports (after signals are fresh)
    await this.boss.schedule(
      JOB_TYPES.DEMO_BUZZ_PREGENERATE,
      '0 6 * * *',
      { clientId: demoClientId },
    );

    logger.info('Demo cron jobs registered (signals 05:30 UTC, buzz 06:00 UTC)');
  }

  private async reapStaleJobs(): Promise<void> {
    try {
      const db = getDb();
      const cutoff = new Date(Date.now() - STALE_JOB_THRESHOLD_MS);

      const staleJobs = await db
        .select({ id: schema.jobs.id, type: schema.jobs.type, updatedAt: schema.jobs.updatedAt })
        .from(schema.jobs)
        .where(
          and(
            eq(schema.jobs.status, 'running'),
            lt(schema.jobs.updatedAt, cutoff),
          ),
        );

      for (const job of staleJobs) {
        logger.warn({ jobId: job.id, type: job.type, updatedAt: job.updatedAt }, 'Reaping stale job — no progress for 15 minutes');
        await db
          .update(schema.jobs)
          .set({
            status: 'failed',
            output: { currentStep: 'Failed — timed out (no progress for 15 minutes)' },
            completedAt: new Date(),
            updatedAt: new Date(),
            errors: [{ item: job.id, error: 'Job timed out — no progress update for 15 minutes (possible server restart)', timestamp: new Date().toISOString() }],
          })
          .where(eq(schema.jobs.id, job.id));
      }

      if (staleJobs.length > 0) {
        logger.info({ count: staleJobs.length }, 'Reaped stale jobs');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to reap stale jobs');
    }
  }

  async stop(): Promise<void> {
    if (this.staleJobTimer) {
      clearInterval(this.staleJobTimer);
      this.staleJobTimer = null;
    }
    await this.boss.stop();
  }
}
