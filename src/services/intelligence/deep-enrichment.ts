import Anthropic from '@anthropic-ai/sdk';
import { getDb, schema } from '../../db/index.js';
import { eq, and, inArray, isNull, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import { registerPrompt, type PromptConfigService } from '../prompt-config/index.js';
import type { JinaProvider } from '../../providers/jina/index.js';
import type { FirecrawlProvider } from '../../providers/firecrawl/index.js';
import type { CreditManager } from '../credit-manager/index.js';

export const PESTLE_PROFILE_PROMPT = `You are a strategic market analyst. Given website content from a company, generate a PESTLE analysis that captures how external macro forces affect this specific business.

For EACH dimension, write 1-3 sentences that are SPECIFIC to this company (not generic statements). If the website provides no evidence for a dimension, write "No evidence from website."

## PESTLE Dimensions

**Political**: Government policies, trade regulations, political stability factors that affect this company. Consider: Which governments/jurisdictions regulate them? Any political dependencies?

**Economic**: Economic conditions that impact this business. Consider: What economic cycles affect their customers? Sensitivity to interest rates, currency, or budget cycles? Revenue model dependencies?

**Social**: Social trends, demographics, cultural factors. Consider: Who are their customers? What social/workforce trends affect demand? Remote work, skills gaps, demographic shifts?

**Technological**: Technology landscape affecting this business. Consider: What tech stack do they use/sell? What tech trends could disrupt or accelerate their market? AI, automation, platform shifts?

**Legal**: Legal and compliance requirements. Consider: What regulations must they comply with? Data protection, industry-specific compliance, licensing, IP considerations?

**Environmental**: Environmental and sustainability factors. Consider: ESG requirements, carbon footprint of their operations, sustainability as a market driver, physical infrastructure dependencies?

Also provide a brief **Company Summary** (2-3 sentences): what they do, who they serve, and their primary value proposition.

Be factual and specific. Only state what can be inferred from the website content provided. Do NOT speculate about things not mentioned.`;

registerPrompt({
  key: 'enrichment.website.pestle.system',
  label: 'Website PESTLE Profile',
  area: 'Deep Enrichment',
  promptType: 'system',
  model: 'claude-haiku-4-5-20251001',
  description: 'System prompt for generating PESTLE analysis from scraped website content',
  defaultContent: PESTLE_PROFILE_PROMPT,
});

interface CompanyForEnrichment {
  id: string;
  domain: string;
  name: string;
  industry?: string | null;
  description?: string | null;
}

export interface EnrichBatchResult {
  profiled: number;
  skipped: number;
  failed: number;
}

export class DeepEnrichmentService {
  private anthropic: Anthropic;
  private jinaProvider: JinaProvider;
  private firecrawlProvider?: FirecrawlProvider;
  private creditManager?: CreditManager;
  private promptConfig?: PromptConfigService;
  private log = logger.child({ service: 'deep-enrichment' });

  constructor(
    anthropicClient: Anthropic,
    jinaProvider: JinaProvider,
    firecrawlProvider?: FirecrawlProvider,
    creditManager?: CreditManager,
  ) {
    this.anthropic = anthropicClient;
    this.jinaProvider = jinaProvider;
    this.firecrawlProvider = firecrawlProvider;
    this.creditManager = creditManager;
  }

  setPromptConfig(promptConfig: PromptConfigService) {
    this.promptConfig = promptConfig;
  }

  /**
   * Enrich a batch of companies by scraping their websites
   * and generating PESTLE profiles via LLM.
   */
  async enrichBatch(
    clientId: string,
    companyIds?: string[],
    options?: { batchSize?: number; jobId?: string },
  ): Promise<EnrichBatchResult> {
    const db = getDb();
    const batchSize = options?.batchSize ?? 50;
    const result: EnrichBatchResult = { profiled: 0, skipped: 0, failed: 0 };

    // Load companies that need profiling
    const conditions = [
      eq(schema.companies.clientId, clientId),
      isNull(schema.companies.websiteProfiledAt),
      sql`${schema.companies.domain} IS NOT NULL`,
    ];
    if (companyIds?.length) {
      conditions.push(inArray(schema.companies.id, companyIds));
    }

    const companies = await db
      .select({
        id: schema.companies.id,
        domain: schema.companies.domain,
        name: schema.companies.name,
        industry: schema.companies.industry,
        description: schema.companies.description,
      })
      .from(schema.companies)
      .where(and(...conditions))
      .limit(batchSize);

    this.log.info({ count: companies.length, clientId }, 'Starting deep enrichment batch');

    // Process with concurrency limit
    const concurrency = 15;
    for (let i = 0; i < companies.length; i += concurrency) {
      const batch = companies.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(c => this.enrichSingleCompany(c as CompanyForEnrichment, clientId)),
      );

      for (const r of results) {
        if (r.status === 'fulfilled') {
          if (r.value) result.profiled++;
          else result.skipped++;
        } else {
          result.failed++;
        }
      }

      // Update job progress if jobId provided
      if (options?.jobId) {
        await db
          .update(schema.jobs)
          .set({ processedItems: result.profiled + result.skipped + result.failed })
          .where(eq(schema.jobs.id, options.jobId));
      }
    }

    this.log.info(result, 'Deep enrichment batch complete');
    return result;
  }

  /**
   * Enrich a single company: scrape website → generate PESTLE profile.
   * Returns the profile text, or null if scraping failed.
   */
  async enrichSingleCompany(company: CompanyForEnrichment, clientId?: string): Promise<string | null> {
    const log = this.log.child({ companyId: company.id, domain: company.domain });

    // Step 1: Scrape website content
    const scrapeResult = await this.jinaProvider.scrapeCompanyWebsite(company.domain);
    let websiteContent = scrapeResult.content;

    // Charge Jina credits if we have a credit manager and client context
    // Jina pricing: ~$20/million tokens (token-metered)
    if (this.creditManager && clientId && scrapeResult.tokensUsed > 0) {
      try {
        const jinaCostUsd = scrapeResult.tokensUsed * 0.00002; // $20/million tokens
        await this.creditManager.charge(clientId, {
          baseCost: jinaCostUsd,
          source: 'jina',
          operation: 'website_scrape',
          description: `Website scrape: ${company.domain} (${scrapeResult.pagesScraped} pages, ${scrapeResult.tokensUsed} tokens)`,
          metadata: { tokensUsed: scrapeResult.tokensUsed, pagesScraped: scrapeResult.pagesScraped },
        });
      } catch (error) {
        log.warn({ error }, 'Failed to charge Jina credits');
      }
    }

    // Fallback to Firecrawl if Jina returned very little content
    if (websiteContent.length < 500 && this.firecrawlProvider) {
      log.info('Jina returned minimal content, falling back to Firecrawl');
      try {
        const fcResult = await this.firecrawlProvider.enrichCompany({ domain: company.domain });
        if (fcResult.success && fcResult.data?.description) {
          websiteContent = fcResult.data.description;
        }
      } catch (error) {
        log.warn({ error }, 'Firecrawl fallback failed');
      }
    }

    if (websiteContent.length < 200) {
      log.info('Insufficient website content for profiling, skipping');
      return null;
    }

    // Step 2: Generate PESTLE profile via LLM
    try {
      let systemPrompt = PESTLE_PROFILE_PROMPT;
      if (this.promptConfig) {
        try {
          systemPrompt = await this.promptConfig.getPrompt('enrichment.website.pestle.system');
        } catch { /* use default */ }
      }

      const userMessage = `## Company: ${company.name}
${company.industry ? `Industry: ${company.industry}` : ''}
${company.description ? `Existing description: ${company.description}` : ''}
Domain: ${company.domain}

## Website Content

${websiteContent}`;

      const response = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      const textBlock = response.content.find(b => b.type === 'text');
      if (!textBlock?.text) {
        log.warn('No text response from PESTLE generation');
        return null;
      }

      const profile = textBlock.text.trim();

      // Step 3: Store the profile
      const db = getDb();
      await db
        .update(schema.companies)
        .set({
          websiteProfile: profile,
          websiteProfiledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.companies.id, company.id));

      log.info({ profileLength: profile.length }, 'PESTLE profile generated');
      return profile;
    } catch (error) {
      log.error({ error }, 'Failed to generate PESTLE profile');
      return null;
    }
  }
}
