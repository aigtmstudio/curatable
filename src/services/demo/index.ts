import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { getDb, schema } from '../../db/index.js';
import { eq, and, inArray, gte, desc, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import { withLlmContext } from '../../lib/llm-tracker.js';
import { scoreCompanyFit } from '../icp-engine/scorer.js';
import {
  DEMO_INDUSTRIES,
  normalizeIndustryInput,
  mapCategoryToSignalType,
  type DemoIndustrySlug,
} from './industry-config.js';
import { transformBuzzReport, type DemoBuzzReport } from './buzz-transformer.js';
import type { IcpFilters } from '../../db/schema/icps.js';
import type { IcpParser } from '../icp-engine/parser.js';
import type { MarketBuzzGenerator } from '../intelligence/market-buzz-generator.js';
import type { MarketSignalProcessor } from '../intelligence/market-signal-processor.js';
import type { MarketSignalSearcher } from '../intelligence/market-signal-searcher.js';
import type { SourceOrchestrator } from '../source-orchestrator/index.js';
import type { IntelligenceScorer } from '../intelligence/intelligence-scorer.js';
import type { CompanySearchParams, UnifiedCompany } from '../../providers/types.js';

// ────────────────────────────────────────────
// Rate Limiter
// ────────────────────────────────────────────

class DemoRateLimiter {
  private perIp = new Map<string, { count: number; windowStart: number }>();
  private globalDaily = { count: 0, dayStart: this.todayStart() };
  private readonly perIpLimit = 10;
  private readonly perIpWindowMs = 3_600_000; // 1 hour
  private readonly globalDailyLimit: number;

  constructor(dailyLimit: number) {
    this.globalDailyLimit = dailyLimit;

    // Periodic cleanup of stale IP entries every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000).unref();
  }

  check(ipHash: string): { allowed: boolean; reason?: string; retryAfterSeconds?: number } {
    const now = Date.now();

    // Reset daily counter if new day
    const todayStart = this.todayStart();
    if (this.globalDaily.dayStart < todayStart) {
      this.globalDaily = { count: 0, dayStart: todayStart };
    }

    // Check global daily
    if (this.globalDaily.count >= this.globalDailyLimit) {
      const nextDay = todayStart + 86_400_000;
      return { allowed: false, reason: 'Daily demo limit reached. Please try again tomorrow.', retryAfterSeconds: Math.ceil((nextDay - now) / 1000) };
    }

    // Check per-IP hourly
    const entry = this.perIp.get(ipHash);
    if (entry) {
      if (now - entry.windowStart > this.perIpWindowMs) {
        this.perIp.set(ipHash, { count: 1, windowStart: now });
      } else if (entry.count >= this.perIpLimit) {
        const retryAfter = Math.ceil((entry.windowStart + this.perIpWindowMs - now) / 1000);
        return { allowed: false, reason: 'Rate limit exceeded. Please try again later.', retryAfterSeconds: retryAfter };
      } else {
        entry.count++;
      }
    } else {
      this.perIp.set(ipHash, { count: 1, windowStart: now });
    }

    this.globalDaily.count++;
    return { allowed: true };
  }

  private todayStart(): number {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.perIp) {
      if (now - entry.windowStart > this.perIpWindowMs) {
        this.perIp.delete(key);
      }
    }
  }
}

// ────────────────────────────────────────────
// Response types (match website contract)
// ────────────────────────────────────────────

export interface DemoSignalResponse {
  id: string;
  headline: string;
  category: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  detectedAt: string;
  relevanceScore: number;
  impactedSectors: string[];
  signalType: string;
}

export interface DemoCompanyResponse {
  id: string;
  name: string;
  domain: string;
  industry: string;
  employeeCount: number;
  signalMatchReason: string;
  approachAngle: string;
  fitScore: number;
  signals: string[];
  location: string;
}

// Re-export DemoBuzzReport for the routes
export type { DemoBuzzReport } from './buzz-transformer.js';

// ────────────────────────────────────────────
// Demo Service
// ────────────────────────────────────────────

interface DemoServiceDeps {
  icpParser: IcpParser;
  marketBuzzGenerator: MarketBuzzGenerator;
  marketSignalProcessor: MarketSignalProcessor;
  marketSignalSearcher?: MarketSignalSearcher;
  orchestrator: SourceOrchestrator;
  intelligenceScorer: IntelligenceScorer;
}

export class DemoService {
  private rateLimiter: DemoRateLimiter;
  private buzzCache = new Map<string, { data: DemoBuzzReport; expiresAt: number }>();
  private discoveryCache = new Map<string, { data: DemoCompanyResponse[]; expiresAt: number }>();
  private hypothesisIdsByIndustry = new Map<DemoIndustrySlug, string[]>();
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly log = logger.child({ service: 'demo' });

  constructor(
    private readonly clientId: string,
    private readonly dailyLimit: number,
    private readonly anthropic: Anthropic,
    private readonly deps: DemoServiceDeps,
  ) {
    this.rateLimiter = new DemoRateLimiter(dailyLimit);

    // Cache cleanup every 30 minutes
    setInterval(() => this.cleanupCaches(), 30 * 60 * 1000).unref();
  }

  // ── Rate Limit Check ────────────────────

  checkRateLimit(ipHash: string): { allowed: boolean; reason?: string; retryAfterSeconds?: number } {
    return this.rateLimiter.check(ipHash);
  }

  // ── Signals Endpoint ────────────────────

  async handleSignals(industry: string, ipHash: string): Promise<DemoSignalResponse[]> {
    const slug = normalizeIndustryInput(industry);
    if (!slug) {
      return []; // Unknown industry — return empty rather than error
    }

    const db = getDb();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Get hypothesis IDs for this industry
    const hypothesisIds = await this.getHypothesisIdsForIndustry(slug);

    let signals: typeof schema.marketSignals.$inferSelect[] = [];

    if (hypothesisIds.length > 0) {
      signals = await db
        .select()
        .from(schema.marketSignals)
        .where(
          and(
            eq(schema.marketSignals.clientId, this.clientId),
            inArray(schema.marketSignals.hypothesisId, hypothesisIds),
            eq(schema.marketSignals.processed, true),
            gte(schema.marketSignals.detectedAt, thirtyDaysAgo),
          ),
        )
        .orderBy(desc(schema.marketSignals.relevanceScore))
        .limit(8);
    }

    // If fewer than 5, broaden to related sectors
    if (signals.length < 5) {
      const config = DEMO_INDUSTRIES[slug];
      const relatedSlugs = config.relatedSectors;
      const additionalIds: string[] = [];

      for (const relatedSlug of relatedSlugs) {
        const ids = await this.getHypothesisIdsForIndustry(relatedSlug as DemoIndustrySlug);
        additionalIds.push(...ids);
      }

      if (additionalIds.length > 0) {
        const existingIds = new Set(signals.map(s => s.id));
        const additional = await db
          .select()
          .from(schema.marketSignals)
          .where(
            and(
              eq(schema.marketSignals.clientId, this.clientId),
              inArray(schema.marketSignals.hypothesisId, additionalIds),
              eq(schema.marketSignals.processed, true),
              gte(schema.marketSignals.detectedAt, thirtyDaysAgo),
            ),
          )
          .orderBy(desc(schema.marketSignals.relevanceScore))
          .limit(8 - signals.length);

        for (const s of additional) {
          if (!existingIds.has(s.id)) signals.push(s);
        }
      }
    }

    return signals.slice(0, 8).map(s => ({
      id: s.id,
      headline: s.headline,
      category: s.signalCategory ?? 'competitive',
      summary: s.summary ?? '',
      sourceName: s.sourceName ?? '',
      sourceUrl: s.sourceUrl ?? '',
      detectedAt: s.detectedAt?.toISOString() ?? s.createdAt.toISOString(),
      relevanceScore: parseFloat(s.relevanceScore ?? '0'),
      impactedSectors: (s.affectedSegments as string[]) ?? [],
      signalType: mapCategoryToSignalType(s.signalCategory),
    }));
  }

  // ── Discovery Endpoint ──────────────────

  async handleDiscovery(icp: string, signal: string, ipHash: string): Promise<DemoCompanyResponse[]> {
    // Check cache
    const cacheKey = this.discoveryHash(icp, signal);
    const cached = this.discoveryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.log.info('Discovery cache hit');
      return cached.data;
    }

    // Parse ICP
    let filters: IcpFilters;
    let confidence: number;
    try {
      const result = await withLlmContext({ clientId: this.clientId }, () =>
        this.deps.icpParser.parseNaturalLanguage(icp),
      );
      filters = result.filters;
      confidence = result.confidence;
    } catch (error) {
      this.log.error({ error }, 'ICP parsing failed');
      throw new DemoError(400, 'Could not parse the ICP description. Please be more specific about your target companies (e.g., industry, size, location).');
    }

    if (confidence < 0.3) {
      throw new DemoError(400, 'The ICP description was too vague. Please include details like industry, company size, location, or technology stack.');
    }

    // Build search params from parsed ICP
    const searchParams: CompanySearchParams = {
      query: icp, // Use raw ICP text as semantic query
      industries: filters.industries,
      employeeCountMin: filters.employeeCountMin,
      employeeCountMax: filters.employeeCountMax,
      revenueMin: filters.revenueMin,
      revenueMax: filters.revenueMax,
      countries: filters.countries,
      keywords: filters.keywords,
      limit: 12,
    };

    // Run pipeline with 14s timeout
    const companies = await this.discoveryPipeline(searchParams, filters, signal);

    // Cache result
    this.discoveryCache.set(cacheKey, {
      data: companies,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });

    return companies;
  }

  private async discoveryPipeline(
    searchParams: CompanySearchParams,
    filters: IcpFilters,
    signal: string,
  ): Promise<DemoCompanyResponse[]> {
    const timeoutMs = 14_000;

    const result = await Promise.race([
      this.runDiscovery(searchParams, filters, signal),
      new Promise<DemoCompanyResponse[]>((resolve) =>
        setTimeout(() => {
          this.log.warn('Discovery timed out at 14s, returning partial results');
          resolve([]);
        }, timeoutMs),
      ),
    ]);

    return result;
  }

  private async runDiscovery(
    searchParams: CompanySearchParams,
    filters: IcpFilters,
    signal: string,
  ): Promise<DemoCompanyResponse[]> {
    // Search companies via orchestrator
    this.log.info({ searchParams }, 'Searching companies for demo discovery');
    const searchResult = await this.deps.orchestrator.searchCompanies(
      this.clientId,
      searchParams,
      { maxProviders: 1 }, // Single provider for speed
    );

    const companies = searchResult.result ?? [];
    if (companies.length === 0) {
      this.log.info('No companies found from search');
      return [];
    }

    // Score each company against ICP
    const scored = companies.map(company => ({
      company,
      fitScore: scoreCompanyFit(company, filters).score,
    }));

    // Sort by fit score and take top 6
    scored.sort((a, b) => b.fitScore - a.fitScore);
    const top6 = scored.slice(0, 6);

    // Generate approach angles via Claude (batch call)
    let aiEnhancements: Array<{ signalMatchReason: string; approachAngle: string }> = [];
    try {
      aiEnhancements = await this.generateApproachAngles(top6.map(s => s.company), signal);
    } catch (error) {
      this.log.error({ error }, 'Approach angle generation failed, using fallbacks');
      aiEnhancements = top6.map(() => ({
        signalMatchReason: `This company operates in a sector directly impacted by: ${signal}`,
        approachAngle: 'Position your solution as a timely response to current market conditions. Reference the specific signal in your outreach.',
      }));
    }

    return top6.map((item, i) => ({
      id: `comp_${i + 1}`,
      name: item.company.name ?? 'Unknown',
      domain: item.company.domain ?? '',
      industry: item.company.industry ?? (filters.industries?.[0] ?? ''),
      employeeCount: item.company.employeeCount ?? 0,
      signalMatchReason: aiEnhancements[i]?.signalMatchReason ?? '',
      approachAngle: aiEnhancements[i]?.approachAngle ?? '',
      fitScore: Math.round(item.fitScore * 100),
      signals: this.extractSignalSummaries(item.company),
      location: this.formatLocation(item.company),
    }));
  }

  private async generateApproachAngles(
    companies: UnifiedCompany[],
    signal: string,
  ): Promise<Array<{ signalMatchReason: string; approachAngle: string }>> {
    const companiesList = companies
      .map((c, i) => `${i}. ${c.name} — ${c.industry ?? 'N/A'}, ${c.employeeCount ?? '?'} employees, ${c.domain ?? 'no domain'}${c.description ? `. ${c.description.slice(0, 200)}` : ''}`)
      .join('\n');

    const response = await withLlmContext({ clientId: this.clientId }, () =>
      this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `You are a B2B sales intelligence analyst. Given a market signal and a list of companies, generate specific, actionable insights for each.

Market Signal: ${signal}

Companies:
${companiesList}

For each company (by index), provide:
- signalMatchReason: One sentence explaining why THIS specific signal is relevant to THIS specific company. Cite concrete evidence where possible (e.g., recent hires, regulatory filings, product announcements).
- approachAngle: One sentence of actionable sales advice — how to start a conversation with this company using the signal as a hook. Be specific, not generic.

Return ONLY valid JSON array (no markdown):
[{"companyIndex": 0, "signalMatchReason": "...", "approachAngle": "..."}]`,
        }],
      }),
    );

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    try {
      const parsed = JSON.parse(text) as Array<{ companyIndex: number; signalMatchReason: string; approachAngle: string }>;
      // Map back to ordered array
      const result = companies.map((_, i) => {
        const entry = parsed.find(p => p.companyIndex === i);
        return {
          signalMatchReason: entry?.signalMatchReason ?? `This company is positioned in a sector affected by: ${signal}`,
          approachAngle: entry?.approachAngle ?? 'Reference the market signal in your outreach to establish relevance.',
        };
      });
      return result;
    } catch {
      this.log.warn('Failed to parse LLM approach angle response, using fallbacks');
      return companies.map(() => ({
        signalMatchReason: `This company operates in a sector directly impacted by: ${signal}`,
        approachAngle: 'Position your solution as a timely response to current market conditions.',
      }));
    }
  }

  private extractSignalSummaries(company: UnifiedCompany): string[] {
    const signals: string[] = [];
    if (company.totalFunding) {
      signals.push(`Funding: ${company.latestFundingStage ?? 'Recent round'} — $${(company.totalFunding / 1_000_000).toFixed(1)}M total`);
    }
    if (company.employeeCount && company.employeeCount > 100) {
      signals.push(`Employee count: ${company.employeeCount}`);
    }
    if (company.techStack && company.techStack.length > 0) {
      signals.push(`Tech stack includes: ${company.techStack.slice(0, 3).join(', ')}`);
    }
    if (signals.length === 0) {
      signals.push(`Operating in ${company.industry ?? 'target sector'}`);
    }
    return signals;
  }

  private formatLocation(company: UnifiedCompany): string {
    const parts: string[] = [];
    if (company.city) parts.push(company.city);
    if (company.state) parts.push(company.state);
    if (company.country) parts.push(company.country);
    return parts.join(', ') || 'Unknown';
  }

  // ── Buzz Endpoint ───────────────────────

  async handleBuzz(industry: string): Promise<DemoBuzzReport> {
    const slug = normalizeIndustryInput(industry);
    if (!slug) {
      throw new DemoError(400, `Unsupported industry. Supported industries: ${Object.values(DEMO_INDUSTRIES).map(c => c.label).join(', ')}`);
    }

    // Check cache
    const cached = this.buzzCache.get(slug);
    if (cached && cached.expiresAt > Date.now()) {
      this.log.info({ industry: slug }, 'Buzz cache hit');
      return cached.data;
    }

    // Try to load from DB
    const db = getDb();
    const [latestReport] = await db
      .select()
      .from(schema.buzzReports)
      .where(
        and(
          eq(schema.buzzReports.clientId, this.clientId),
          eq(schema.buzzReports.status, 'completed'),
        ),
      )
      .orderBy(desc(schema.buzzReports.createdAt))
      .limit(1);

    if (latestReport?.report) {
      const config = DEMO_INDUSTRIES[slug];
      const transformed = transformBuzzReport(latestReport.report, latestReport.id, config.label);

      this.buzzCache.set(slug, {
        data: transformed,
        expiresAt: Date.now() + this.CACHE_TTL_MS,
      });

      return transformed;
    }

    // No report exists — generate synchronously (first-deploy fallback)
    this.log.info({ industry: slug }, 'No cached buzz report, generating on-demand');
    try {
      const report = await withLlmContext({ clientId: this.clientId }, () =>
        this.deps.marketBuzzGenerator.generateBuzzReport({
          clientId: this.clientId,
          timeWindowDays: 30,
          forceRegenerate: true,
        }),
      );

      const config = DEMO_INDUSTRIES[slug];
      const transformed = transformBuzzReport(report, `buzz_${Date.now()}`, config.label);

      this.buzzCache.set(slug, {
        data: transformed,
        expiresAt: Date.now() + this.CACHE_TTL_MS,
      });

      return transformed;
    } catch (error) {
      this.log.error({ error }, 'On-demand buzz generation failed');
      throw new DemoError(503, 'Market intelligence report is being generated. Please try again in a few minutes.');
    }
  }

  // ── Cron: Refresh Demo Signals ──────────

  async refreshDemoSignals(): Promise<void> {
    if (!this.deps.marketSignalSearcher) {
      this.log.warn('MarketSignalSearcher not available, skipping demo signal refresh');
      return;
    }

    this.log.info('Starting demo signal refresh');

    for (const [slug] of Object.entries(DEMO_INDUSTRIES)) {
      try {
        const hypothesisIds = await this.getHypothesisIdsForIndustry(slug as DemoIndustrySlug);
        if (hypothesisIds.length === 0) {
          this.log.warn({ industry: slug }, 'No hypotheses found, skipping');
          continue;
        }

        this.log.info({ industry: slug, hypothesisCount: hypothesisIds.length }, 'Searching for evidence');
        await withLlmContext({ clientId: this.clientId }, () =>
          this.deps.marketSignalSearcher!.searchForEvidence(this.clientId, {
            hypothesisIds,
            maxSearchesPerHypothesis: 3,
          }),
        );
      } catch (error) {
        this.log.error({ error, industry: slug }, 'Signal refresh failed for industry');
      }
    }

    // Process unclassified signals
    try {
      this.log.info('Processing unclassified demo signals');
      await withLlmContext({ clientId: this.clientId }, () =>
        this.deps.marketSignalProcessor.processUnclassifiedSignals(this.clientId, 100),
      );
    } catch (error) {
      this.log.error({ error }, 'Signal processing failed');
    }

    this.log.info('Demo signal refresh complete');
  }

  // ── Cron: Pre-generate Buzz Reports ─────

  async pregenerateBuzzReports(): Promise<void> {
    this.log.info('Starting demo buzz pre-generation');

    for (const [slug, config] of Object.entries(DEMO_INDUSTRIES)) {
      try {
        this.log.info({ industry: slug }, 'Generating buzz report');

        const report = await withLlmContext({ clientId: this.clientId }, () =>
          this.deps.marketBuzzGenerator.generateBuzzReport({
            clientId: this.clientId,
            timeWindowDays: 30,
            forceRegenerate: true,
          }),
        );

        const transformed = transformBuzzReport(report, `buzz_${slug}_${Date.now()}`, config.label);

        this.buzzCache.set(slug as DemoIndustrySlug, {
          data: transformed,
          expiresAt: Date.now() + this.CACHE_TTL_MS,
        });

        this.log.info({ industry: slug, topics: report.trendingTopics.length }, 'Buzz report cached');
      } catch (error) {
        this.log.error({ error, industry: slug }, 'Buzz pre-generation failed for industry');
      }
    }

    this.log.info('Demo buzz pre-generation complete');
  }

  // ── Analytics Logging ───────────────────

  async logRequest(params: {
    endpoint: string;
    industry?: string;
    icpText?: string;
    ipHash: string;
    userAgent?: string;
    responseTimeMs: number;
    statusCode: number;
  }): Promise<void> {
    try {
      const db = getDb();
      await db.insert(schema.demoRequests).values({
        endpoint: params.endpoint,
        industry: params.industry ?? null,
        icpText: params.icpText ?? null,
        ipHash: params.ipHash,
        userAgent: params.userAgent ?? null,
        responseTimeMs: params.responseTimeMs,
        statusCode: params.statusCode,
      });
    } catch (error) {
      // Non-blocking — don't fail the request for analytics
      this.log.error({ error }, 'Failed to log demo request');
    }
  }

  // ── Helpers ─────────────────────────────

  private async getHypothesisIdsForIndustry(slug: DemoIndustrySlug): Promise<string[]> {
    // Check in-memory cache
    const cached = this.hypothesisIdsByIndustry.get(slug);
    if (cached) return cached;

    const config = DEMO_INDUSTRIES[slug];
    if (!config) return [];

    const db = getDb();
    const hypotheses = await db
      .select({ id: schema.signalHypotheses.id })
      .from(schema.signalHypotheses)
      .where(
        and(
          eq(schema.signalHypotheses.clientId, this.clientId),
          eq(schema.signalHypotheses.status, 'active'),
          // Match by affected segments overlapping with industry segments
          sql`${schema.signalHypotheses.affectedSegments}::jsonb ?| array[${sql.join(
            config.segments.map(s => sql`${s}`),
            sql`,`,
          )}]`,
        ),
      );

    const ids = hypotheses.map(h => h.id);
    this.hypothesisIdsByIndustry.set(slug, ids);
    return ids;
  }

  private discoveryHash(icp: string, signal: string): string {
    const normalised = `${icp.toLowerCase().trim()}|${signal.toLowerCase().trim()}`;
    return createHash('sha256').update(normalised).digest('hex');
  }

  private cleanupCaches(): void {
    const now = Date.now();
    for (const [key, value] of this.buzzCache) {
      if (value.expiresAt < now) this.buzzCache.delete(key);
    }
    for (const [key, value] of this.discoveryCache) {
      if (value.expiresAt < now) this.discoveryCache.delete(key);
    }
  }
}

// ────────────────────────────────────────────
// Custom error for demo endpoints
// ────────────────────────────────────────────

export class DemoError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'DemoError';
  }
}
