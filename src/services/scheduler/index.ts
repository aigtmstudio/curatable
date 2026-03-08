import PgBoss from 'pg-boss';
import { getDb, schema } from '../../db/index.js';
import { eq, and, isNotNull } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';

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

  async stop(): Promise<void> {
    await this.boss.stop();
  }
}
