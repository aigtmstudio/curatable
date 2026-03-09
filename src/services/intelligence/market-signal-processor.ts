import Anthropic from '@anthropic-ai/sdk';
import { getDb, schema } from '../../db/index.js';
import { eq, and, desc, sql, inArray, isNull, gte, like } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import { registerPrompt, type PromptConfigService } from '../prompt-config/index.js';
import { computeTimelinessMultiplier } from './timeliness.js';

// ── Source credibility tiers ──────────────────────────────────────────────────
//
// Executive teams are heavily influenced by authoritative sources. Signals from
// major financial press and analyst firms carry much greater weight than unknown
// blogs or social media. This multiplier is applied ONLY to the promotion decision
// (which companies move from TAM to active_segment) — NOT to the stored
// relevanceScore — so the buzz report is unaffected.

const TIER_1_DOMAINS = new Set([
  // Major financial press
  'ft.com', 'bloomberg.com', 'wsj.com', 'reuters.com', 'economist.com',
  // Analyst and advisory firms
  'mckinsey.com', 'gartner.com', 'forrester.com', 'deloitte.com', 'bcg.com',
  'pwc.com', 'bain.com', 'spglobal.com',
  // Institutional / academic
  'hbr.org', 'imf.org', 'worldbank.org', 'oecd.org',
]);

const TIER_2_DOMAINS = new Set([
  'cnbc.com', 'axios.com', 'politico.com', 'politico.eu', 'theguardian.com',
  'bbc.co.uk', 'bbc.com', 'thetimes.co.uk', 'telegraph.co.uk',
  'businessinsider.com', 'techcrunch.com', 'wired.com', 'venturebeat.com',
  'sifted.eu', 'theregister.com', 'arstechnica.com',
]);

// sourceName prefixes that indicate social/low-credibility signals
const TWEET_SOURCE_PREFIX = 'exa_tweet_';

/**
 * Returns a multiplier (applied on top of the timeliness multiplier) reflecting
 * the credibility of the signal's source domain. Higher-tier sources make it
 * easier for a signal to cross the promotion threshold; tweet sources make it
 * effectively impossible, since boards are not influenced by social media chatter.
 */
function computeSourceCredibilityMultiplier(
  sourceUrl?: string | null,
  sourceName?: string | null,
): number {
  // Tweets: very low weight for ICP promotion decisions
  if (sourceName?.startsWith(TWEET_SOURCE_PREFIX)) return 0.5;

  if (!sourceUrl) return 1.0;
  try {
    const hostname = new URL(sourceUrl).hostname.replace(/^www\./, '');
    if (TIER_1_DOMAINS.has(hostname)) return 1.5;
    if (TIER_2_DOMAINS.has(hostname)) return 1.15;
  } catch {
    // invalid URL — treat as default
  }
  return 1.0;
}

export const CLASSIFICATION_PROMPT = `You are a market signal classifier. Given a market signal (headline + summary) and a set of active hypotheses, determine:

1. Which hypothesis (if any) this signal best matches
2. A relevance score (0.00-1.00) — how strongly this signal relates to the matched hypothesis
3. The signal category (regulatory, economic, industry, competitive)
4. Which market segments are affected

If no hypothesis matches well, set hypothesisIndex to -1 and still classify the category and relevance.

Return ONLY valid JSON:
{
  "hypothesisIndex": number (-1 if no match),
  "relevanceScore": number (0.00-1.00),
  "signalCategory": "regulatory"|"economic"|"industry"|"competitive",
  "affectedSegments": string[],
  "reasoning": string
}`;

export interface IngestSignalInput {
  clientId: string;
  headline: string;
  summary?: string;
  sourceUrl?: string;
  sourceName?: string;
  rawData?: Record<string, unknown>;
  detectedAt?: string;
}

export interface SignalFeedOptions {
  clientId: string;
  category?: string;
  processed?: boolean;
  hypothesisId?: string;
  sourceName?: string; // exact match or prefix with trailing %
  segment?: string; // ILIKE search on affectedSegments JSONB array
  limit?: number;
  offset?: number;
}

registerPrompt({
  key: 'signal.market.classification.system',
  label: 'Market Signal Classification',
  area: 'Signal Detection',
  promptType: 'system',
  model: 'claude-haiku-4-5-20251001',
  description: 'System prompt for classifying incoming market signals against active hypotheses',
  defaultContent: CLASSIFICATION_PROMPT,
});

export const PROMOTION_PROMPT = `You are a strict market analyst evaluating whether a market event DIRECTLY and MATERIALLY affects specific companies.

A market signal has been detected. For each company below, evaluate whether this signal meaningfully affects their business using their PESTLE profile.

## Evaluation Rules — BE CONSERVATIVE

- DEFAULT to NOT affected. Only mark affected=true when the evidence is unambiguous.
- A company IS affected only if their PESTLE profile shows DIRECT, SPECIFIC exposure to the forces in the signal — not general industry membership.
- Generic overlap ("they're in tech and this is a tech trend") is NOT sufficient. You need concrete evidence from the profile.
- "No evidence", vague language, or indirect connection → affected=false.
- Confidence below 0.8 means you're not sure → affected=false.
- Expect that most companies (60-80%) will NOT be affected by any given signal.

## Signal-to-PESTLE Mapping

Focus your evaluation on the most relevant PESTLE dimensions:
- regulatory signal → Legal, Political
- economic signal → Economic
- industry signal → Social, Technological
- competitive signal → Technological, Economic

## Calibration

Ask yourself: "Would this signal cause THIS specific company's buyer to urgently seek out the client's product RIGHT NOW?" If you cannot answer yes confidently from the profile text, mark affected=false.

Return ONLY a valid JSON array of objects for companies where affected=true AND confidence >= 0.8:
[{ "companyIndex": number, "affected": true, "confidence": number (0.8-1.0), "pestleDimension": "Political"|"Economic"|"Social"|"Technological"|"Legal"|"Environmental", "reasoning": "1 sentence citing the SPECIFIC text from the company profile that confirms direct exposure" }]

If NO companies are affected, return an empty array: []`;

registerPrompt({
  key: 'signal.market.promotion.system',
  label: 'Market Signal Company Promotion',
  area: 'Signal Detection',
  promptType: 'system',
  model: 'claude-haiku-4-5-20251001',
  description: 'System prompt for evaluating which companies are affected by a market signal using PESTLE profiles',
  defaultContent: PROMOTION_PROMPT,
});

export class MarketSignalProcessor {
  private anthropic: Anthropic;
  private promptConfig?: PromptConfigService;

  constructor(anthropicClient: Anthropic) {
    this.anthropic = anthropicClient;
  }

  setPromptConfig(promptConfig: PromptConfigService) {
    this.promptConfig = promptConfig;
  }

  async ingestSignal(input: IngestSignalInput) {
    const db = getDb();
    const [signal] = await db
      .insert(schema.marketSignals)
      .values({
        clientId: input.clientId,
        headline: input.headline,
        summary: input.summary ?? null,
        sourceUrl: input.sourceUrl ?? null,
        sourceName: input.sourceName ?? null,
        rawData: input.rawData ?? {},
        detectedAt: input.detectedAt ? new Date(input.detectedAt) : new Date(),
        processed: false,
      })
      .returning();
    return signal;
  }

  async ingestBatch(signals: IngestSignalInput[]) {
    const db = getDb();
    const inserted = await db
      .insert(schema.marketSignals)
      .values(
        signals.map(s => ({
          clientId: s.clientId,
          headline: s.headline,
          summary: s.summary ?? null,
          sourceUrl: s.sourceUrl ?? null,
          sourceName: s.sourceName ?? null,
          rawData: s.rawData ?? {},
          detectedAt: s.detectedAt ? new Date(s.detectedAt) : new Date(),
          processed: false,
        })),
      )
      .returning();
    return inserted;
  }

  async processUnclassifiedSignals(clientId?: string, batchSize = 50): Promise<number> {
    const db = getDb();
    const log = logger.child({ clientId, batchSize });
    log.info('Processing unclassified market signals');

    // Fetch unprocessed signals
    const conditions = [eq(schema.marketSignals.processed, false)];
    if (clientId) {
      conditions.push(eq(schema.marketSignals.clientId, clientId));
    }

    const unprocessed = await db
      .select()
      .from(schema.marketSignals)
      .where(and(...conditions))
      .limit(batchSize)
      .orderBy(schema.marketSignals.createdAt);

    if (unprocessed.length === 0) {
      log.info('No unprocessed signals found');
      return 0;
    }

    log.info({ count: unprocessed.length }, 'Found unprocessed signals');
    let processedCount = 0;

    // Pre-classify social signals (influencer posts, tweets) without LLM — they don't drive ICP promotion
    const SOCIAL_PREFIXES = ['influencer_', 'exa_tweet_'];
    const socialSignals = unprocessed.filter(s =>
      s.sourceName && SOCIAL_PREFIXES.some(p => s.sourceName!.startsWith(p)),
    );
    const llmSignals = unprocessed.filter(s =>
      !s.sourceName || !SOCIAL_PREFIXES.some(p => s.sourceName!.startsWith(p)),
    );

    if (socialSignals.length > 0) {
      await db
        .update(schema.marketSignals)
        .set({
          signalCategory: 'social',
          relevanceScore: '0.40',
          affectedSegments: [],
          processed: true,
          processedAt: new Date(),
        })
        .where(inArray(schema.marketSignals.id, socialSignals.map(s => s.id)));
      processedCount += socialSignals.length;
      log.info({ count: socialSignals.length }, 'Pre-classified social signals');
    }

    // Group remaining (non-social) signals by client for LLM classification
    const signalsByClient = new Map<string, typeof unprocessed>();
    for (const signal of llmSignals) {
      const group = signalsByClient.get(signal.clientId) ?? [];
      group.push(signal);
      signalsByClient.set(signal.clientId, group);
    }

    for (const [cId, signals] of signalsByClient) {
      // Load active hypotheses for this client
      const hypotheses = await db
        .select()
        .from(schema.signalHypotheses)
        .where(and(
          eq(schema.signalHypotheses.clientId, cId),
          eq(schema.signalHypotheses.status, 'active'),
        ))
        .orderBy(schema.signalHypotheses.priority);

      const hypothesesContext = hypotheses.length > 0
        ? hypotheses.map((h, i) => `[${i}] ${h.hypothesis} (category: ${h.signalCategory})`).join('\n')
        : 'No hypotheses defined. Classify the signal by category only.';

      // Classify signals in parallel
      let classificationPrompt = CLASSIFICATION_PROMPT;
      if (this.promptConfig) {
        try { classificationPrompt = await this.promptConfig.getPrompt('signal.market.classification.system'); } catch { /* use default */ }
      }

      const CLASSIFY_CONCURRENCY = 15;
      for (let si = 0; si < signals.length; si += CLASSIFY_CONCURRENCY) {
        const signalBatch = signals.slice(si, si + CLASSIFY_CONCURRENCY);
        const results = await Promise.allSettled(
          signalBatch.map(async (signal) => {
            const userMessage = `## Signal\nHeadline: ${signal.headline}\n${signal.summary ? `Summary: ${signal.summary}` : ''}\n${signal.sourceName ? `Source: ${signal.sourceName}` : ''}\n\n## Active Hypotheses\n${hypothesesContext}`;

            const message = await this.anthropic.messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 512,
              system: classificationPrompt,
              messages: [{ role: 'user', content: userMessage }],
            });

            const textBlock = message.content.find(b => b.type === 'text');
            if (!textBlock?.text) {
              log.warn({ signalId: signal.id }, 'No text response from classification');
              return null;
            }

            const cleaned = textBlock.text.replace(/```json\n?|\n?```/g, '').trim();
            const classification = JSON.parse(cleaned) as {
              hypothesisIndex: number;
              relevanceScore: number;
              signalCategory: string;
              affectedSegments: string[];
              reasoning: string;
            };

            const matchedHypothesis = classification.hypothesisIndex >= 0 && classification.hypothesisIndex < hypotheses.length
              ? hypotheses[classification.hypothesisIndex]
              : null;

            // Validate category
            const validCategories = ['regulatory', 'economic', 'industry', 'competitive', 'social'] as const;
            const category = validCategories.includes(classification.signalCategory as typeof validCategories[number])
              ? classification.signalCategory as typeof validCategories[number]
              : null;

            // Update signal with classification
            await db
              .update(schema.marketSignals)
              .set({
                hypothesisId: matchedHypothesis?.id ?? null,
                signalCategory: category,
                relevanceScore: String(Math.max(0, Math.min(1, classification.relevanceScore)).toFixed(2)),
                affectedSegments: classification.affectedSegments ?? [],
                processed: true,
                processedAt: new Date(),
              })
              .where(eq(schema.marketSignals.id, signal.id));

            // If high relevance AND recent AND from a credible source, promote
            // companies from TAM to active_segment.
            const { multiplier: timeMult, band: timeBand } = computeTimelinessMultiplier(signal.detectedAt);
            const credibilityMult = computeSourceCredibilityMultiplier(signal.sourceUrl, signal.sourceName);
            const adjustedRelevance = classification.relevanceScore * timeMult * credibilityMult;

            log.debug({
              signalId: signal.id,
              rawRelevance: classification.relevanceScore,
              timeliness: { multiplier: timeMult, band: timeBand },
              credibility: { multiplier: credibilityMult, sourceUrl: signal.sourceUrl, sourceName: signal.sourceName },
              adjustedRelevance,
            }, 'Timeliness+credibility-adjusted relevance');

            if (adjustedRelevance >= 0.75 && classification.affectedSegments?.length > 0) {
              await this.promoteCompanies(
                cId, classification.affectedSegments, signal.id,
                matchedHypothesis?.id, classification.relevanceScore,
                { headline: signal.headline, summary: signal.summary ?? undefined, category: classification.signalCategory },
                signal.detectedAt ?? undefined,
              );
            }

            log.debug({
              signalId: signal.id,
              relevance: classification.relevanceScore,
              matchedHypothesis: matchedHypothesis?.id,
              category,
            }, 'Signal classified');

            return signal.id;
          }),
        );

        for (let ri = 0; ri < results.length; ri++) {
          const settled = results[ri];
          if (settled.status === 'fulfilled') {
            processedCount++;
          } else {
            const signal = signalBatch[ri];
            log.error({ error: settled.reason, signalId: signal.id }, 'Failed to classify signal');
            // Mark as processed to avoid retry loops; set low relevance
            await db
              .update(schema.marketSignals)
              .set({
                processed: true,
                processedAt: new Date(),
                relevanceScore: '0.00',
              })
              .where(eq(schema.marketSignals.id, signal.id));
            processedCount++;
          }
        }
      }
    }

    log.info({ processedCount }, 'Signal processing complete');
    return processedCount;
  }

  private async promoteCompanies(
    clientId: string,
    affectedSegments: string[],
    signalId: string,
    hypothesisId?: string | null,
    relevanceScore?: number,
    signalContext?: { headline: string; summary?: string; category?: string },
    signalDetectedAt?: Date,
  ) {
    const db = getDb();
    const log = logger.child({ clientId, signalId, segments: affectedSegments });

    // Load TAM + active_segment companies for this client, filtered to strong ICP fits only (>= 0.65).
    // This skips weak-fit companies to save LLM costs and keep the pipeline focused.
    const ICP_FIT_THRESHOLD = '0.65';
    const rows = await db
      .select({ company: schema.companies })
      .from(schema.companies)
      .innerJoin(
        schema.listMembers,
        and(
          eq(schema.listMembers.companyId, schema.companies.id),
          isNull(schema.listMembers.removedAt),
        ),
      )
      .where(and(
        eq(schema.companies.clientId, clientId),
        inArray(schema.companies.pipelineStage, ['tam', 'active_segment']),
        gte(schema.listMembers.icpFitScore, ICP_FIT_THRESHOLD),
      ));
    // Deduplicate in case a company appears in multiple lists
    const seen = new Set<string>();
    const tamCompanies = rows
      .map(r => r.company)
      .filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });

    if (tamCompanies.length === 0) {
      log.debug('No TAM/active companies with strong ICP fit to evaluate');
      return;
    }

    log.info({ tamCount: tamCompanies.length }, 'Evaluating TAM/active companies (ICP >= 65%) against market signal');

    // Get promotion prompt
    let promotionPrompt = PROMOTION_PROMPT;
    if (this.promptConfig) {
      try { promotionPrompt = await this.promptConfig.getPrompt('signal.market.promotion.system'); } catch { /* use default */ }
    }

    // Map signal category to primary PESTLE dimensions
    const pestleFocus: Record<string, string> = {
      regulatory: 'Legal and Political',
      economic: 'Economic',
      industry: 'Social and Technological',
      competitive: 'Technological and Economic',
      social: 'Social and Cultural',
    };
    const primaryDimensions = pestleFocus[signalContext?.category ?? ''] ?? 'all dimensions';

    // Build signal description
    const signalDescription = signalContext
      ? `HEADLINE: ${signalContext.headline}\n${signalContext.summary ? `SUMMARY: ${signalContext.summary}` : ''}`
      : `Signal ID: ${signalId}`;

    // Process in batches of 12 companies
    const BATCH_SIZE = 12;
    const promotedCompanies: Array<{ company: typeof tamCompanies[0]; confidence: number; pestleDimension: string; reasoning: string }> = [];

    for (let i = 0; i < tamCompanies.length; i += BATCH_SIZE) {
      const batch = tamCompanies.slice(i, i + BATCH_SIZE);

      const companiesBlock = batch.map((c, idx) => {
        const profile = c.websiteProfile
          ?? ([c.description, c.industry ? `Industry: ${c.industry}` : '', c.subIndustry ? `Sub-industry: ${c.subIndustry}` : '']
            .filter(Boolean).join('\n')
          || 'No profile available');
        // Cap profile text to keep prompt manageable
        const trimmedProfile = profile.length > 1500 ? profile.slice(0, 1500) + '...' : profile;
        return `[${idx}] ${c.name} | ${c.industry ?? 'Unknown industry'}\n    PESTLE Profile:\n    ${trimmedProfile}`;
      }).join('\n\n');

      const userMessage = `## Market Signal\n${signalDescription}\nAFFECTED SEGMENTS: ${affectedSegments.join(', ')}\nSIGNAL CATEGORY: ${signalContext?.category ?? 'unknown'}\nPRIMARY PESTLE DIMENSIONS TO CHECK: ${primaryDimensions}\n\n## Companies to Evaluate\n${companiesBlock}`;

      try {
        const message = await this.anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2048,
          system: promotionPrompt,
          messages: [{ role: 'user', content: userMessage }],
        });

        const textBlock = message.content.find(b => b.type === 'text');
        if (!textBlock?.text) {
          log.warn({ batchStart: i }, 'No text response from promotion evaluation');
          continue;
        }

        const cleaned = textBlock.text.replace(/```json\n?|\n?```/g, '').trim();
        const evaluations = JSON.parse(cleaned) as Array<{
          companyIndex: number;
          affected: boolean;
          confidence: number;
          pestleDimension: string;
          reasoning: string;
        }>;

        if (!Array.isArray(evaluations)) continue;

        for (const evaluation of evaluations) {
          if (!evaluation.affected || evaluation.confidence < 0.8) continue;
          if (evaluation.companyIndex < 0 || evaluation.companyIndex >= batch.length) continue;

          promotedCompanies.push({
            company: batch[evaluation.companyIndex],
            confidence: Math.max(0, Math.min(1, evaluation.confidence)),
            pestleDimension: evaluation.pestleDimension,
            reasoning: evaluation.reasoning,
          });
        }
      } catch (error) {
        log.error({ error, batchStart: i }, 'Failed to evaluate company batch');
      }
    }

    if (promotedCompanies.length === 0) {
      log.info('No companies matched signal after LLM evaluation');
      return;
    }

    log.info({ matchCount: promotedCompanies.length }, 'Applying market signal evidence to companies via PESTLE evaluation');

    // Promote matched companies (or add signal records to already-active ones)
    for (const { company, confidence, pestleDimension, reasoning } of promotedCompanies) {
      // Promote all list memberships that are still at 'tam' for this company.
      // pipelineStage lives on listMembers (per-list) so each list tracks progression independently.
      await db
        .update(schema.listMembers)
        .set({ pipelineStage: 'active_segment' })
        .where(and(
          eq(schema.listMembers.companyId, company.id),
          isNull(schema.listMembers.removedAt),
          eq(schema.listMembers.pipelineStage, 'tam'),
        ));

      // Create company_signal record with LLM evidence
      await db
        .insert(schema.companySignals)
        .values({
          companyId: company.id,
          clientId,
          signalType: 'market_signal',
          signalStrength: String(Math.max(0, Math.min(1, (relevanceScore ?? 0.7) * confidence)).toFixed(2)),
          signalData: {
            evidence: reasoning,
            details: {
              marketSignalId: signalId,
              hypothesisId,
              pestleDimension,
              confidence,
              signalHeadline: signalContext?.headline,
            },
            eventDate: signalDetectedAt?.toISOString() ?? null,
          },
          source: 'market_signal_processor',
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
        });
    }

    // Recalculate signal scores for promoted companies
    for (const { company } of promotedCompanies) {
      const signals = await db
        .select()
        .from(schema.companySignals)
        .where(eq(schema.companySignals.companyId, company.id));

      const avgScore = signals.length > 0
        ? signals.reduce((sum, s) => sum + parseFloat(s.signalStrength), 0) / signals.length
        : 0;

      await db
        .update(schema.companies)
        .set({ signalScore: String(avgScore.toFixed(2)) })
        .where(eq(schema.companies.id, company.id));
    }
  }

  async getSignalFeed(options: SignalFeedOptions) {
    const db = getDb();
    const conditions = [eq(schema.marketSignals.clientId, options.clientId)];

    if (options.category) {
      const validCategories = ['regulatory', 'economic', 'industry', 'competitive', 'social'] as const;
      if (validCategories.includes(options.category as typeof validCategories[number])) {
        conditions.push(eq(schema.marketSignals.signalCategory, options.category as typeof validCategories[number]));
      }
    }
    if (options.processed !== undefined) {
      conditions.push(eq(schema.marketSignals.processed, options.processed));
    }
    if (options.hypothesisId) {
      conditions.push(eq(schema.marketSignals.hypothesisId, options.hypothesisId));
    }
    if (options.sourceName) {
      conditions.push(
        options.sourceName.endsWith('%')
          ? like(schema.marketSignals.sourceName, options.sourceName)
          : eq(schema.marketSignals.sourceName, options.sourceName),
      );
    }
    if (options.segment) {
      conditions.push(
        sql`${schema.marketSignals.affectedSegments}::text ILIKE ${'%' + options.segment + '%'}`,
      );
    }

    const signals = await db
      .select()
      .from(schema.marketSignals)
      .where(and(...conditions))
      .orderBy(desc(schema.marketSignals.createdAt))
      .limit(options.limit ?? 50)
      .offset(options.offset ?? 0);

    // Get total count
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.marketSignals)
      .where(and(...conditions));

    return { signals, total: Number(count) };
  }

  async getSignalById(id: string) {
    const db = getDb();
    const [signal] = await db
      .select()
      .from(schema.marketSignals)
      .where(eq(schema.marketSignals.id, id));
    return signal ?? null;
  }
}
