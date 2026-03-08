import Anthropic from '@anthropic-ai/sdk';
import { eq, and, desc } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import type {
  MarketBuilderPlan,
  ProviderTask,
  FeedbackEntry,
  ExecutionRecord,
} from '../../db/schema/market-builder.js';
import type { CompanyDiscoveryService } from '../company-discovery/index.js';
import type { ListBuilder } from '../list-builder/index.js';
import { logger } from '../../lib/logger.js';

export type { MarketBuilderPlan, ProviderTask, ExecutionRecord };

export interface SavedPlan {
  id: string;
  clientId: string;
  icpId: string | null;
  plan: MarketBuilderPlan;
  status: string;
  feedbackHistory: FeedbackEntry[];
  executionHistory: ExecutionRecord[];
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a market research strategist for a B2B sales intelligence platform. Your job is to create an optimal TAM (Total Addressable Market) discovery plan for a client, based on their ICP (Ideal Customer Profile).

## Available Discovery Providers

### Physical / Local Business Discovery
Use these for clients targeting hospitality, food & beverage, retail, venues, or any business with a physical location.

- **google_places**: Google Maps scraper. Best all-round source for finding local businesses by type and city. Params: \`query\` (e.g. "restaurants", "coffee shops", "independent retailers"), \`location\` (e.g. "London, UK"), \`limit\` (default 100)
- **listings_opentable**: OpenTable restaurant booking listings. Great for finding sit-down restaurants in the UK & US. Params: \`location\` (city name), \`limit\`
- **listings_ubereats**: UberEats delivery listings. Best for takeaways and delivery-enabled restaurants. Params: \`location\` (city name), \`limit\`
- **listings_justeat**: JustEat listings. Best for UK takeaways and casual dining. Params: \`location\` (city name), \`limit\`
- **reviews**: Google Places with LLM filtering for negative payment/checkout reviews. Highly targeted for payment technology products — finds businesses actively frustrated with their current payment setup. Params: \`location\`, \`category\` (e.g. "restaurant"), \`limit\`
- **news**: News article scraping + LLM extraction of new business openings, expansions, refurbishments. Params: \`queries\` (array of search strings, e.g. ["new restaurant opening London 2026", "restaurant refurbishment UK"]), \`limit\`

### B2B / Digital Business Discovery
Use these for clients targeting software companies, professional services, enterprises, or any company found via business databases.

- **apollo**: Apollo / LinkedIn B2B database. Best for finding companies by industry, employee count, funding stage, and tech stack. Uses the ICP filters directly — no extra params needed. Params: \`limit\` (optional)

### Social Discovery
Use when the ICP is community-driven or the client sells into social-first industries.

- **social_instagram**: Instagram keyword scraping. Best for hospitality, lifestyle, consumer brands. Params: \`queries\` (keyword array), \`limit\`
- **social_linkedin**: LinkedIn post keyword scraping. Best for B2B industries. Params: \`queries\` (keyword array), \`limit\`

## Strategy Patterns

**Hospitality / Food & Beverage / Retail** (restaurants, cafes, bars, hotels, retail shops, venues):
→ Primary: google_places + listings (opentable and/or ubereats/justeat depending on geography)
→ Supplemental: news (new openings), reviews (payment pain signal)

**B2B / SaaS / Professional Services** (software, fintech, HR tech, professional services, enterprise):
→ Primary: apollo
→ Supplemental: news (funding/launches), social_linkedin

**Hybrid** (brands with physical + digital presence, e-commerce with stores):
→ Primary: apollo + google_places
→ Supplemental: news, listings

## Using Past Approved Plans

When provided with previously approved plans, use them as calibration anchors. Note what worked and adapt the strategy accordingly. Explicitly reference relevant past examples in your reasoning.

## Output Format

Return a single valid JSON object with exactly this structure:
{
  "reasoning": "2–4 paragraphs of markdown text. Cover: (1) what the ICP tells you about the types of businesses being targeted, (2) why you chose the specific providers and what each will contribute, (3) what the user should expect from the results",
  "vertical": "A short descriptive label (e.g. 'UK Hospitality & Food Service', 'B2B SaaS – HR Tech', 'E-commerce Retail')",
  "providers": [
    {
      "provider": "<slug>",
      "priority": "primary|supplemental",
      "rationale": "One sentence explaining why this provider is right for this specific ICP",
      "params": { ... }
    }
  ],
  "expectedOutcome": "One sentence summarising expected volume and data quality (e.g. '150–400 restaurants and cafes in London with structured address, phone, and website data')",
  "version": 1
}

Only include providers that are genuinely relevant. Fewer well-targeted providers are better than many irrelevant ones. Populate location params from the ICP's geo filters. Generate relevant search queries from the ICP's industries and keywords.`;

// ── Service ────────────────────────────────────────────────────────────────────

export class MarketBuilderService {
  private readonly log = logger.child({ service: 'market-builder' });

  constructor(
    private readonly discoveryService: CompanyDiscoveryService,
    private readonly listBuilder: ListBuilder,
    private readonly anthropic: Anthropic,
  ) {}

  // ── Plan generation ──────────────────────────────────────────────────────────

  async generatePlan(clientId: string, icpId?: string): Promise<MarketBuilderPlan> {
    const db = getDb();

    // Load specific ICP if provided, otherwise first active ICP
    const [icp] = icpId
      ? await db.select().from(schema.icps).where(eq(schema.icps.id, icpId)).limit(1)
      : await db.select().from(schema.icps)
          .where(and(eq(schema.icps.clientId, clientId), eq(schema.icps.isActive, true)))
          .limit(1);

    // Load past approved plans (all clients) for few-shot examples
    const pastPlans = await this.loadApprovedPlans(5);

    // Build ICP context
    const icpContext = this.buildIcpContext(icp);

    // Build few-shot examples section
    const examplesSection = this.buildExamplesSection(pastPlans);

    const userMessage = [icpContext, examplesSection].filter(Boolean).join('\n\n');

    this.log.info({ clientId, icpId: icp?.id, pastPlanCount: pastPlans.length }, 'Generating market builder plan');

    const response = await this.anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    return this.parsePlan(text, 1);
  }

  async refinePlan(plan: MarketBuilderPlan, feedback: string, clientId: string): Promise<MarketBuilderPlan> {
    const db = getDb();
    const [icp] = await db
      .select()
      .from(schema.icps)
      .where(and(eq(schema.icps.clientId, clientId), eq(schema.icps.isActive, true)))
      .limit(1);

    const userMessage = [
      this.buildIcpContext(icp),
      `## Current Plan (version ${plan.version})\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``,
      `## User Feedback\n${feedback}`,
      `Revise the plan to address the feedback. Increment \`version\` to ${plan.version + 1}. Keep the same JSON structure.`,
    ].filter(Boolean).join('\n\n');

    this.log.info({ clientId, feedback: feedback.substring(0, 100) }, 'Refining market builder plan');

    const response = await this.anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    return this.parsePlan(text, plan.version + 1);
  }

  // ── Plan persistence ─────────────────────────────────────────────────────────

  async approvePlan(clientId: string, icpId: string | null, plan: MarketBuilderPlan): Promise<SavedPlan> {
    const db = getDb();

    // Archive any existing approved/draft plans for this client+icp
    await db
      .update(schema.icpBuildPlans)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(and(
        eq(schema.icpBuildPlans.clientId, clientId),
        ...(icpId ? [eq(schema.icpBuildPlans.icpId, icpId)] : []),
      ));

    const [saved] = await db
      .insert(schema.icpBuildPlans)
      .values({
        clientId,
        icpId: icpId ?? null,
        plan,
        status: 'approved',
        feedbackHistory: [],
        executionHistory: [],
        approvedAt: new Date(),
      })
      .returning();

    this.log.info({ clientId, icpId, planId: saved.id }, 'Market builder plan approved');
    return saved as SavedPlan;
  }

  async getApprovedPlan(clientId: string, icpId?: string): Promise<SavedPlan | null> {
    const db = getDb();
    const conditions = [
      eq(schema.icpBuildPlans.clientId, clientId),
      eq(schema.icpBuildPlans.status, 'approved'),
    ];
    if (icpId) conditions.push(eq(schema.icpBuildPlans.icpId, icpId));

    const [plan] = await db
      .select()
      .from(schema.icpBuildPlans)
      .where(and(...conditions))
      .orderBy(desc(schema.icpBuildPlans.approvedAt))
      .limit(1);

    return (plan as SavedPlan) ?? null;
  }

  // ── Plan execution ───────────────────────────────────────────────────────────

  async executePlan(savedPlanId: string, clientId: string, listId?: string): Promise<ExecutionRecord> {
    const db = getDb();
    const [saved] = await db
      .select()
      .from(schema.icpBuildPlans)
      .where(eq(schema.icpBuildPlans.id, savedPlanId));

    if (!saved) throw new Error(`Plan not found: ${savedPlanId}`);

    const plan = saved.plan as MarketBuilderPlan;
    const record = await this.runProviders(clientId, plan, listId, saved.icpId ?? undefined);

    // Append execution record to history
    const history = [...((saved.executionHistory as ExecutionRecord[]) ?? []), record];
    await db
      .update(schema.icpBuildPlans)
      .set({ executionHistory: history, updatedAt: new Date() })
      .where(eq(schema.icpBuildPlans.id, savedPlanId));

    this.log.info({ savedPlanId, totalAdded: record.totalAdded }, 'Market builder plan executed');
    return record;
  }

  async generateAndExecute(clientId: string, listId?: string): Promise<{ plan: MarketBuilderPlan; result: ExecutionRecord }> {
    const plan = await this.generatePlan(clientId);
    const db = getDb();
    const [icp] = await db
      .select({ id: schema.icps.id })
      .from(schema.icps)
      .where(and(eq(schema.icps.clientId, clientId), eq(schema.icps.isActive, true)))
      .limit(1);

    const saved = await this.approvePlan(clientId, icp?.id ?? null, plan);
    const result = await this.runProviders(clientId, plan, listId, icp?.id);

    const history = [result];
    await db
      .update(schema.icpBuildPlans)
      .set({ executionHistory: history, updatedAt: new Date() })
      .where(eq(schema.icpBuildPlans.id, saved.id));

    return { plan, result };
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  private async runProviders(
    clientId: string,
    plan: MarketBuilderPlan,
    listId?: string,
    icpId?: string,
  ): Promise<ExecutionRecord> {
    const record: ExecutionRecord = {
      executedAt: new Date().toISOString(),
      listId,
      byProvider: {},
      totalFound: 0,
      totalAdded: 0,
    };

    // Discovery-based providers (not apollo) add to companies table; track whether any ran
    const discoveryProviders = new Set(['google_places', 'listings_opentable', 'listings_ubereats', 'listings_justeat', 'news', 'reviews']);
    let discoveryRan = false;

    const tasks = plan.providers.map(async (task) => {
      try {
        const result = await this.runProviderTask(clientId, task, listId, icpId);
        record.byProvider[task.provider] = result;
        record.totalFound += result.found;
        record.totalAdded += result.added;
        if (discoveryProviders.has(task.provider) && result.added > 0) discoveryRan = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error({ provider: task.provider, err }, 'Provider task failed');
        record.byProvider[task.provider] = { found: 0, added: 0, error: msg };
      }
    });

    await Promise.allSettled(tasks);

    // After discovery providers finish, build the list to score + add discovered companies
    if (discoveryRan && listId) {
      const resolvedIcpId = icpId ?? await this.resolveIcpId(clientId);
      if (resolvedIcpId) {
        try {
          this.log.info({ clientId, listId, resolvedIcpId }, 'Running list build after discovery to score and add companies');
          const buildResult = await this.listBuilder.buildList({ clientId, listId, icpId: resolvedIcpId });
          record.byProvider['_list_build'] = { found: buildResult.companiesAdded, added: buildResult.companiesAdded };
          record.totalAdded += buildResult.companiesAdded;
          this.log.info({ companiesAdded: buildResult.companiesAdded }, 'Post-discovery list build complete');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.error({ err }, 'Post-discovery list build failed');
          record.byProvider['_list_build'] = { found: 0, added: 0, error: msg };
        }
      } else {
        this.log.warn({ clientId, listId }, 'No ICP found for client — skipping post-discovery list build');
      }
    }

    return record;
  }

  private async resolveIcpId(clientId: string): Promise<string | undefined> {
    const db = getDb();
    const [icp] = await db
      .select({ id: schema.icps.id })
      .from(schema.icps)
      .where(and(eq(schema.icps.clientId, clientId), eq(schema.icps.isActive, true)))
      .limit(1);
    return icp?.id;
  }

  private async runProviderTask(
    clientId: string,
    task: ProviderTask,
    listId?: string,
    icpId?: string,
  ): Promise<{ found: number; added: number }> {
    const p = task.params;

    switch (task.provider) {
      case 'google_places': {
        const r = await this.discoveryService.discoverFromGooglePlaces({
          clientId,
          query: p.query ?? 'businesses',
          location: p.location ?? '',
          limit: p.limit,
        });
        return { found: r.companiesFound, added: r.companiesAdded };
      }

      case 'listings_opentable':
      case 'listings_ubereats':
      case 'listings_justeat': {
        const platform = task.provider.replace('listings_', '') as 'opentable' | 'ubereats' | 'justeat';
        const r = await this.discoveryService.discoverFromListings({
          clientId,
          platform,
          location: p.location ?? '',
          limit: p.limit,
        });
        return { found: r.companiesFound, added: r.companiesAdded };
      }

      case 'news': {
        const r = await this.discoveryService.discoverFromNews({
          clientId,
          queries: p.queries ?? [],
          limit: p.limit,
        });
        return { found: r.companiesFound, added: r.companiesAdded };
      }

      case 'reviews': {
        const r = await this.discoveryService.discoverFromReviews({
          clientId,
          location: p.location ?? '',
          category: p.category,
          limit: p.limit,
        });
        return { found: r.companiesFound, added: r.companiesAdded };
      }

      case 'apollo': {
        if (!listId || !icpId) {
          this.log.warn({ clientId }, 'Apollo provider skipped — listId and icpId required');
          return { found: 0, added: 0 };
        }
        const r = await this.listBuilder.buildList({ clientId, listId, icpId, limit: p.limit });
        return { found: r.companiesAdded, added: r.companiesAdded };
      }

      case 'social_instagram':
      case 'social_linkedin': {
        const platform = task.provider === 'social_instagram' ? 'instagram' : 'linkedin';
        // Load social keywords from active ICPs
        const icps = await getDb().select().from(schema.icps)
          .where(and(eq(schema.icps.clientId, clientId), eq(schema.icps.isActive, true)));
        const socialKw = icps.flatMap(i => (i.socialKeywords as string[]) ?? []);
        if (socialKw.length === 0) {
          this.log.info({ provider: task.provider }, 'Social discovery skipped — no socialKeywords on active ICPs');
          return { found: 0, added: 0 };
        }
        const r = await this.discoveryService.discoverFromSocial({
          clientId,
          platform: platform as 'instagram' | 'linkedin',
          keywords: [...new Set(socialKw)],
          icpId: icpId ?? undefined,
          limit: p.limit ?? 20,
        });
        return { found: r.companiesFound, added: r.companiesAdded };
      }

      default:
        this.log.warn({ provider: task.provider }, 'Unknown provider in plan, skipping');
        return { found: 0, added: 0 };
    }
  }

  private buildIcpContext(icp: typeof schema.icps.$inferSelect | undefined): string {
    if (!icp) return '## ICP\nNo active ICP found for this client. Generate a general discovery plan.';

    const parts = [`## Ideal Customer Profile: ${icp.name}`];
    if (icp.description) parts.push(`Description: ${icp.description}`);
    if (icp.naturalLanguageInput) parts.push(`ICP Definition: ${icp.naturalLanguageInput}`);

    const f = icp.filters as Record<string, unknown>;
    if (Array.isArray(f.industries) && f.industries.length) parts.push(`Target Industries: ${f.industries.join(', ')}`);
    if (Array.isArray(f.countries) && f.countries.length) parts.push(`Target Countries: ${f.countries.join(', ')}`);
    if (Array.isArray(f.cities) && f.cities.length) parts.push(`Target Cities: ${f.cities.join(', ')}`);
    if (Array.isArray(f.keywords) && f.keywords.length) parts.push(`Keywords: ${f.keywords.join(', ')}`);
    if (f.employeeCountMin || f.employeeCountMax) {
      parts.push(`Employee Count: ${f.employeeCountMin ?? 0}–${f.employeeCountMax ?? 'unlimited'}`);
    }
    if (f.revenueMin || f.revenueMax) {
      parts.push(`Revenue Range: ${f.revenueMin ?? 0}–${f.revenueMax ?? 'unlimited'}`);
    }
    if (Array.isArray(f.techStack) && f.techStack.length) parts.push(`Tech Stack: ${f.techStack.join(', ')}`);
    if (Array.isArray(f.fundingStages) && f.fundingStages.length) parts.push(`Funding Stages: ${f.fundingStages.join(', ')}`);

    return parts.join('\n');
  }

  private buildExamplesSection(plans: SavedPlan[]): string {
    if (plans.length === 0) return '';

    const examples = plans.map((p, i) => {
      const lastExecution = p.executionHistory[p.executionHistory.length - 1];
      const resultSummary = lastExecution
        ? `(executed: ${lastExecution.totalAdded} companies added across ${Object.keys(lastExecution.byProvider).join(', ')})`
        : '(not yet executed)';

      return `### Example ${i + 1}: ${p.plan.vertical} ${resultSummary}
Providers used: ${p.plan.providers.map(t => `${t.provider}[${t.priority}]`).join(', ')}
Expected outcome: ${p.plan.expectedOutcome}`;
    });

    return `## Previously Approved Plans (for reference)\nUse these as calibration examples. Adapt — don't blindly copy.\n\n${examples.join('\n\n')}`;
  }

  private async loadApprovedPlans(limit: number): Promise<SavedPlan[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.icpBuildPlans)
      .where(eq(schema.icpBuildPlans.status, 'approved'))
      .orderBy(desc(schema.icpBuildPlans.approvedAt))
      .limit(limit);
    return rows as SavedPlan[];
  }

  private parsePlan(text: string, expectedVersion: number): MarketBuilderPlan {
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
    // Extract JSON object from response (handles leading text)
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      this.log.error({ text: text.substring(0, 300) }, 'No JSON object found in market builder response');
      throw new Error('Failed to parse market builder plan response');
    }
    try {
      const plan = JSON.parse(jsonMatch[0]) as MarketBuilderPlan;
      plan.version = expectedVersion;
      return plan;
    } catch {
      this.log.error({ raw: jsonMatch[0].substring(0, 300) }, 'JSON parse failed for market builder plan');
      throw new Error('Failed to parse market builder plan JSON');
    }
  }
}
