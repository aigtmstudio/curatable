import Anthropic from '@anthropic-ai/sdk';
import type { SourceOrchestrator } from '../source-orchestrator/index.js';
import type { EnrichmentPipeline } from '../enrichment/index.js';
import type { CompanySearchParams, UnifiedCompany } from '../../providers/types.js';
import type { IcpFilters, ProviderSearchHints } from '../../db/schema/icps.js';
import type { SourceRecord } from '../../db/schema/companies.js';
import { scoreCompanyFit } from '../icp-engine/scorer.js';
import { getDb, schema } from '../../db/index.js';
import { eq, and } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import { registerPrompt, type PromptConfigService } from '../prompt-config/index.js';
import type { TavilyProvider } from '../../providers/tavily/index.js';
import type { ApifyProvider } from '../../providers/apify/index.js';
import type { ExaProvider } from '../../providers/exa/index.js';
import { mapGooglePlaceToCompany } from '../../providers/apify/mappers.js';
import type { ListingPlatform, SocialPlatform } from '../../providers/apify/types.js';

// Domains that are platforms/social sites, not actual companies.
// Results with these domains are noise from search providers.
const BLOCKED_DOMAINS = new Set([
  'linktr.ee', 'linktree.com',
  'facebook.com', 'fb.com',
  'instagram.com',
  'twitter.com', 'x.com',
  'linkedin.com',
  'youtube.com', 'youtu.be',
  'tiktok.com',
  'pinterest.com',
  'reddit.com',
  'yelp.com',
  'tripadvisor.com',
  'wikipedia.org',
  'crunchbase.com',
  'glassdoor.com',
  'indeed.com',
  'medium.com',
  'substack.com',
  'github.com',
  'about.me',
  'bit.ly',
  'goo.gl',
  'magnet.me',
  'wordpress.com',
  'blogspot.com',
  'wixsite.com',
  'squarespace.com',
  'weebly.com',
  'tumblr.com',
  'google.com',
]);

// Platform/social site names to block even when domain is null
// (e.g. Apollo returns "Linktree" with no domain)
const BLOCKED_NAMES = new Set([
  'linktree', 'facebook', 'instagram', 'twitter', 'linkedin',
  'youtube', 'tiktok', 'pinterest', 'reddit', 'medium',
  'substack', 'github', 'wordpress', 'squarespace',
  'wix', 'weebly', 'tumblr', 'glassdoor', 'indeed',
  'crunchbase', 'yelp', 'tripadvisor', 'wikipedia',
]);

export function isBlockedCompanyName(name: string | undefined): boolean {
  if (!name) return false;
  return BLOCKED_NAMES.has(name.toLowerCase().trim());
}

export function isBlockedDomain(domain: string | undefined): boolean {
  if (!domain) return false;
  const lower = domain.toLowerCase().replace(/^www\./, '');
  // Check exact match and parent domain (e.g. "en.wikipedia.org" → "wikipedia.org")
  if (BLOCKED_DOMAINS.has(lower)) return true;
  const parts = lower.split('.');
  if (parts.length > 2) {
    const parent = parts.slice(-2).join('.');
    if (BLOCKED_DOMAINS.has(parent)) return true;
  }
  // Also block country-specific variants (glassdoor.co.uk, yelp.co.uk, etc.)
  if (parts.length > 2) {
    const baseName = parts.slice(0, -2).join('.');
    const parentDomain = baseName.split('.').pop();
    if (parentDomain && BLOCKED_DOMAINS.has(parentDomain + '.com')) return true;
  }
  return false;
}

/**
 * Filter out results that aren't actual companies.
 * Exa (web search) sometimes returns directory pages, review aggregators,
 * industry association pages, or generic list pages.
 */
const NON_COMPANY_PATTERNS = [
  /^companies\b/i,           // "Companies & Reviews", "Companies in..."
  /\bcompanies\s+(in|&|and)\b/i,
  /\b(review|rating)s?\b/i,  // Review/rating aggregator pages
  /\blist\s+of\b/i,          // "List of restaurants in..."
  /\btop\s+\d+\b/i,          // "Top 10 hospitality..."
  /\bbest\s+\d+\b/i,         // "Best 50 restaurants..."
  /\bdirectory\b/i,          // Directories
  /\bassociation\b/i,        // Industry associations
  /\bfederation\b/i,         // Industry federations
  /\bcouncil\b/i,            // Industry councils (not companies)
  /\bawards?\b/i,            // "Restaurant & Bar Design Awards"
  /\bjobs?\s+(in|at|for)\b/i, // Job listing pages
  /\bcareers?\s+(in|at)\b/i,
];

/** Check if a company name looks like a real company (not a directory, awards page, etc.) */
export function isPlausibleCompanyName(name: string | undefined): boolean {
  if (!name) return true; // No name to check — don't reject
  for (const pattern of NON_COMPANY_PATTERNS) {
    if (pattern.test(name)) return false;
  }
  return true;
}

function isPlausibleCompany(company: UnifiedCompany): boolean {
  // Companies without domains are suspicious but might be from AI discovery
  if (!company.domain && !company.name) return false;

  const name = company.name ?? '';

  // Check if the name looks like a non-company result
  for (const pattern of NON_COMPANY_PATTERNS) {
    if (pattern.test(name)) {
      logger.debug({ name, domain: company.domain }, 'Filtered non-company result');
      return false;
    }
  }

  return true;
}

export interface DiscoveryResult {
  companiesDiscovered: number;
  companiesScored: number;
  companiesAdded: number;
  contactsFound: number;
  providersUsed: string[];
  totalCost: number;
  warnings?: string[];
  /** IDs of companies newly inserted into the DB during this discovery run */
  newCompanyIds: string[];
}

export const AI_DISCOVERY_PROMPT = `List {{limit}} real companies that match this ideal customer profile. Only include companies you are confident actually exist.

Filters:
{{filters}}

Return ONLY a JSON array of objects with "name" and "domain" fields. Example:
[{"name": "Pfizer", "domain": "pfizer.com"}, {"name": "Johnson & Johnson", "domain": "jnj.com"}]

Rules:
- Only real, currently operating companies
- Include the company's primary website domain (not linkedin or wikipedia)
- Focus on well-known companies that clearly match the criteria
- No duplicates`;

registerPrompt({
  key: 'discovery.ai.user',
  label: 'AI Company Discovery',
  area: 'Company Discovery',
  promptType: 'user',
  model: 'claude-sonnet-4-20250514',
  description: 'User prompt template for AI-powered company discovery fallback. Use {{limit}} and {{filters}} placeholders.',
  defaultContent: AI_DISCOVERY_PROMPT,
});

export interface NewsDiscoveryResult {
  articlesSearched: number;
  companiesFound: number;
  companiesAdded: number;
  source: string;
}

export interface PlacesDiscoveryResult {
  placesSearched: number;
  companiesFound: number;
  companiesAdded: number;
  source: string;
}

export interface SocialDiscoveryResult {
  postsSearched: number;
  companiesFound: number;
  companiesAdded: number;
  source: string;
}

export class CompanyDiscoveryService {
  private anthropic: Anthropic;
  private promptConfig?: PromptConfigService;
  private tavilyProvider?: TavilyProvider;
  private apifyProvider?: ApifyProvider;
  private exaProvider?: ExaProvider;

  constructor(
    private orchestrator: SourceOrchestrator,
    private enrichment: EnrichmentPipeline,
    anthropicClient: Anthropic,
  ) {
    this.anthropic = anthropicClient;
  }

  setPromptConfig(promptConfig: PromptConfigService) {
    this.promptConfig = promptConfig;
  }

  setTavilyProvider(provider: TavilyProvider) {
    this.tavilyProvider = provider;
  }

  setApifyProvider(provider: ApifyProvider) {
    this.apifyProvider = provider;
  }

  setExaProvider(provider: ExaProvider) {
    this.exaProvider = provider;
  }

  /**
   * Discover companies from local news articles (new openings, expansions, refurbishments).
   * Uses Tavily to search news and LLM to extract business names from articles.
   */
  async discoverFromNews(params: {
    clientId: string;
    queries: string[];
    limit?: number;
  }): Promise<NewsDiscoveryResult> {
    if (!this.tavilyProvider) {
      throw new Error('Tavily provider not configured');
    }

    const result: NewsDiscoveryResult = { articlesSearched: 0, companiesFound: 0, companiesAdded: 0, source: 'news_discovery' };
    const log = logger.child({ clientId: params.clientId, service: 'company-discovery', method: 'news' });

    // Pre-load existing domains for dedup
    const existing = await getDb()
      .select({ domain: schema.companies.domain, name: schema.companies.name })
      .from(schema.companies)
      .where(eq(schema.companies.clientId, params.clientId));
    const existingDomains = new Set(existing.map(c => c.domain).filter(Boolean).map(d => d!.toLowerCase()));
    const existingNames = new Set(existing.map(c => c.name.toLowerCase()));

    const allArticles: Array<{ title: string; content: string; url: string }> = [];

    for (const query of params.queries) {
      try {
        const response = await this.tavilyProvider.searchNews({ query, maxResults: 5, days: 30 });
        if (response.results?.length) {
          allArticles.push(...response.results.map(r => ({
            title: r.title ?? query,
            content: r.content?.slice(0, 500) ?? '',
            url: r.url ?? '',
          })));
          result.articlesSearched += response.results.length;
        }
      } catch (err) {
        log.warn({ query, err }, 'Tavily news search failed');
      }
    }

    if (allArticles.length === 0) return result;

    // LLM extraction: extract business names from articles
    const articleSummary = allArticles
      .slice(0, 20)
      .map(a => `Title: ${a.title}\nExcerpt: ${a.content}`)
      .join('\n---\n');

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Extract real business names from these news articles. Focus on restaurants, hospitality venues, or food service businesses that are opening, expanding, or refurbishing.\n\nArticles:\n${articleSummary}\n\nReturn ONLY a valid JSON array of objects: [{"name": "Restaurant Name", "website": "example.com", "city": "London", "description": "one sentence"}]\nOmit website/city if unknown. Return [] if none found.`,
        }],
      });

      const text = response.content.find(b => b.type === 'text')?.text ?? '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return result;

      const extracted = JSON.parse(jsonMatch[0]) as Array<{ name: string; website?: string; city?: string; description?: string }>;
      result.companiesFound = extracted.length;

      for (const business of extracted.slice(0, params.limit ?? 50)) {
        if (!business.name) continue;
        if (existingNames.has(business.name.toLowerCase())) continue;
        if (business.website && existingDomains.has(business.website.toLowerCase())) continue;

        const company: UnifiedCompany = {
          name: business.name,
          domain: business.website,
          websiteUrl: business.website ? `https://${business.website}` : undefined,
          city: business.city,
          description: business.description,
          industry: 'Restaurant',
          externalIds: {},
        };

        await this.upsertDiscoveredCompanyWithSource(params.clientId, company, 'news_discovery');
        if (business.website) existingDomains.add(business.website.toLowerCase());
        existingNames.add(business.name.toLowerCase());
        result.companiesAdded++;
      }
    } catch (err) {
      log.error({ err }, 'LLM extraction from news articles failed');
    }

    log.info(result, 'News-based company discovery complete');
    return result;
  }

  /**
   * Discover companies from Google Places.
   */
  async discoverFromGooglePlaces(params: {
    clientId: string;
    query: string;
    location: string;
    limit?: number;
  }): Promise<PlacesDiscoveryResult> {
    if (!this.apifyProvider) {
      throw new Error('Apify provider not configured');
    }

    const result: PlacesDiscoveryResult = { placesSearched: 0, companiesFound: 0, companiesAdded: 0, source: 'google_places' };
    const log = logger.child({ clientId: params.clientId, service: 'company-discovery', method: 'google_places' });

    const existing = await getDb()
      .select({ domain: schema.companies.domain })
      .from(schema.companies)
      .where(eq(schema.companies.clientId, params.clientId));
    const existingDomains = new Set(existing.map(c => c.domain).filter(Boolean).map(d => d!.toLowerCase()));

    const places = await this.apifyProvider.searchGooglePlaces({
      query: params.query,
      location: params.location,
      limit: params.limit ?? 50,
    });
    result.placesSearched = places.length;

    for (const place of places) {
      const company = mapGooglePlaceToCompany(place);
      if (!company.name || company.name === 'Unknown') continue;
      if (company.domain && existingDomains.has(company.domain.toLowerCase())) continue;

      await this.upsertDiscoveredCompanyWithSource(params.clientId, company, 'google_places');
      if (company.domain) existingDomains.add(company.domain.toLowerCase());
      result.companiesAdded++;
    }

    result.companiesFound = result.companiesAdded;
    log.info(result, 'Google Places discovery complete');
    return result;
  }

  /**
   * Discover companies with negative payment/checkout reviews via Google Places reviews.
   */
  async discoverFromReviews(params: {
    clientId: string;
    location: string;
    category?: string;
    limit?: number;
  }): Promise<PlacesDiscoveryResult> {
    if (!this.apifyProvider) {
      throw new Error('Apify provider not configured');
    }

    const result: PlacesDiscoveryResult = { placesSearched: 0, companiesFound: 0, companiesAdded: 0, source: 'review_discovery' };
    const log = logger.child({ clientId: params.clientId, service: 'company-discovery', method: 'reviews' });

    const existing = await getDb()
      .select({ domain: schema.companies.domain, name: schema.companies.name })
      .from(schema.companies)
      .where(eq(schema.companies.clientId, params.clientId));
    const existingDomains = new Set(existing.map(c => c.domain).filter(Boolean).map(d => d!.toLowerCase()));
    const existingNames = new Set(existing.map(c => c.name.toLowerCase()));

    const places = await this.apifyProvider.searchGooglePlaces({
      query: params.category ?? 'restaurant',
      location: params.location,
      limit: params.limit ?? 100,
      includeReviews: true,
    });
    result.placesSearched = places.length;

    // LLM analysis: identify businesses with payment/checkout complaints
    const placesWithReviews = places
      .filter(p => p.reviews && p.reviews.length > 0)
      .slice(0, 50);

    if (placesWithReviews.length === 0) return result;

    const reviewSummary = placesWithReviews.map(p => ({
      name: p.title,
      reviews: p.reviews?.filter(r => r.stars && r.stars <= 3).map(r => r.text).slice(0, 3),
    })).filter(p => p.reviews && p.reviews.length > 0);

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `Identify businesses from this list that have negative reviews specifically about payment processing, card machines, card payments, checkout, or billing issues.\n\n${JSON.stringify(reviewSummary, null, 2)}\n\nReturn ONLY a JSON array of business names: ["Restaurant A", "Café B"]. Return [] if none found.`,
        }],
      });

      const text = response.content.find(b => b.type === 'text')?.text ?? '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return result;

      const matchedNames = new Set((JSON.parse(jsonMatch[0]) as string[]).map(n => n.toLowerCase()));

      for (const place of placesWithReviews) {
        if (!place.title || !matchedNames.has(place.title.toLowerCase())) continue;
        if (existingNames.has(place.title.toLowerCase())) continue;

        const company = mapGooglePlaceToCompany(place);
        if (company.domain && existingDomains.has(company.domain.toLowerCase())) continue;

        await this.upsertDiscoveredCompanyWithSource(params.clientId, company, 'review_discovery');
        if (company.domain) existingDomains.add(company.domain.toLowerCase());
        existingNames.add(place.title.toLowerCase());
        result.companiesAdded++;
      }

      result.companiesFound = matchedNames.size;
    } catch (err) {
      log.error({ err }, 'LLM review analysis failed');
    }

    log.info(result, 'Review-based company discovery complete');
    return result;
  }

  /**
   * Discover companies from delivery/booking platform listings.
   * Uses Exa domain-scoped search (site:just-eat.co.uk, site:ubereats.com, etc.)
   * rather than brittle platform-specific scrapers.
   */
  async discoverFromListings(params: {
    clientId: string;
    platform: ListingPlatform;
    location: string;
    limit?: number;
  }): Promise<PlacesDiscoveryResult> {
    if (!this.exaProvider) {
      throw new Error('Exa provider not configured — required for listing discovery');
    }

    const PLATFORM_DOMAINS: Record<ListingPlatform, string[]> = {
      opentable: ['opentable.co.uk', 'opentable.com'],
      ubereats: ['ubereats.com'],
      justeat: ['just-eat.co.uk'],
    };

    const result: PlacesDiscoveryResult = { placesSearched: 0, companiesFound: 0, companiesAdded: 0, source: `listing_discovery_${params.platform}` };
    const log = logger.child({ clientId: params.clientId, service: 'company-discovery', method: 'listings', platform: params.platform });

    const targetLimit = params.limit ?? 50;

    // Dedup by name (these listing pages don't have the restaurant's own domain)
    const existing = await getDb()
      .select({ name: schema.companies.name })
      .from(schema.companies)
      .where(eq(schema.companies.clientId, params.clientId));
    const existingNames = new Set(existing.map(c => c.name?.toLowerCase().trim()).filter(Boolean) as string[]);

    const domains = PLATFORM_DOMAINS[params.platform];
    const loc = params.location;

    // Query pool: cuisine-type variations let us fan out beyond a single "restaurants" search.
    // Each query typically returns 15–30 unique venues so we generate enough to cover the target.
    const QUERY_POOL = [
      `restaurants in ${loc}`,
      `Indian restaurant in ${loc}`,
      `Chinese restaurant in ${loc}`,
      `Italian restaurant in ${loc}`,
      `Japanese restaurant in ${loc}`,
      `Thai restaurant in ${loc}`,
      `Mexican restaurant in ${loc}`,
      `Turkish restaurant in ${loc}`,
      `pizza restaurant in ${loc}`,
      `burger restaurant in ${loc}`,
      `sushi restaurant in ${loc}`,
      `cafe coffee shop in ${loc}`,
      `pub food in ${loc}`,
      `fast food takeaway in ${loc}`,
      `brunch restaurant in ${loc}`,
      `French restaurant in ${loc}`,
      `Greek restaurant in ${loc}`,
      `Spanish restaurant in ${loc}`,
      `Vietnamese restaurant in ${loc}`,
      `Korean restaurant in ${loc}`,
    ];

    // Fetch ~30 per query. Generate enough queries to (likely) fill the quota given dedup waste.
    const BATCH_SIZE = 30;
    const numQueries = Math.min(Math.ceil(targetLimit / BATCH_SIZE) + 1, QUERY_POOL.length);
    const queries = QUERY_POOL.slice(0, numQueries);

    log.info({ targetLimit, numQueries, platform: params.platform, location: loc }, 'Starting listing discovery');

    for (const query of queries) {
      if (result.companiesAdded >= targetLimit) break;

      const fetchSize = Math.min(BATCH_SIZE, targetLimit - result.companiesAdded + 10);

      try {
        const rawResults = await this.exaProvider.searchWithDomains(query, domains, fetchSize);
        result.placesSearched += rawResults.length;

        for (const r of rawResults) {
          if (result.companiesAdded >= targetLimit) break;
          if (!r.title) continue;
          // Strip platform suffix: "Wagamama - Just Eat" → "Wagamama", "Pizza Express | Uber Eats" → "Pizza Express"
          const name = r.title.split(/\s*[-|]\s*/)[0].trim();
          if (!name || name.length < 2) continue;
          if (existingNames.has(name.toLowerCase())) continue;

          const company: UnifiedCompany = {
            name,
            websiteUrl: r.url,
            city: loc,
            industry: 'Restaurant',
            externalIds: { [`listing_${params.platform}`]: r.url },
          };

          await this.upsertDiscoveredCompanyWithSource(params.clientId, company, result.source);
          existingNames.add(name.toLowerCase());
          result.companiesAdded++;
        }
      } catch (err) {
        log.warn({ query, err }, 'Exa listing search failed for query — continuing');
      }
    }

    result.companiesFound = result.companiesAdded;
    log.info(result, 'Listing-based company discovery complete (Exa domain search)');
    return result;
  }

  /**
   * Discover companies from social media posts using LLM extraction.
   * Analyses post text and author info to find ICP-matching companies.
   */
  async discoverFromSocial(params: {
    clientId: string;
    platform: SocialPlatform;
    keywords: string[];
    icpId?: string;
    limit?: number;
  }): Promise<SocialDiscoveryResult> {
    if (!this.apifyProvider) {
      throw new Error('Apify provider not configured');
    }

    const result: SocialDiscoveryResult = { postsSearched: 0, companiesFound: 0, companiesAdded: 0, source: 'social_discovery' };
    const log = logger.child({ clientId: params.clientId, service: 'company-discovery', method: 'social', platform: params.platform });

    // Load ICP filters for LLM context + exclusions
    let icpContext = '';
    let excludeDomains: string[] = [];
    let excludeKeywords: string[] = [];
    if (params.icpId) {
      const [icp] = await getDb()
        .select()
        .from(schema.icps)
        .where(eq(schema.icps.id, params.icpId));
      if (icp) {
        const filters = icp.filters as IcpFilters | null;
        const parts: string[] = [];
        if (icp.description) parts.push(`Description: ${icp.description}`);
        if (filters?.industries?.length) parts.push(`Industries: ${filters.industries.join(', ')}`);
        if (filters?.countries?.length) parts.push(`Geography: ${filters.countries.join(', ')}`);
        if (filters?.cities?.length) parts.push(`Cities: ${filters.cities.join(', ')}`);
        if (filters?.employeeCountMin || filters?.employeeCountMax) {
          parts.push(`Employee size: ${filters.employeeCountMin ?? 0}–${filters.employeeCountMax ?? '∞'}`);
        }
        if (filters?.keywords?.length) parts.push(`Keywords: ${filters.keywords.join(', ')}`);
        icpContext = parts.join('\n');
        excludeDomains = (filters?.excludeDomains ?? []).map(d => d.toLowerCase());
        excludeKeywords = (filters?.excludeKeywords ?? []).map(k => k.toLowerCase());
      }
    }

    // Pre-load existing companies for dedup
    const existing = await getDb()
      .select({ domain: schema.companies.domain, name: schema.companies.name })
      .from(schema.companies)
      .where(eq(schema.companies.clientId, params.clientId));
    const existingDomains = new Set(existing.map(c => c.domain).filter(Boolean).map(d => d!.toLowerCase()));
    const existingNames = new Set(existing.map(c => c.name.toLowerCase()));

    // Fetch social posts
    const posts = await this.apifyProvider.searchSocialPosts({
      platform: params.platform,
      keywords: params.keywords,
      limit: params.limit ?? 20,
    });
    result.postsSearched = posts.length;

    if (posts.length === 0) return result;

    // Build post summary for LLM (truncated for token efficiency)
    const postSummary = posts.slice(0, 30).map((p, i) => {
      const author = [p.authorName, p.authorHandle ? `@${p.authorHandle}` : ''].filter(Boolean).join(' ');
      const text = (p.text ?? '').slice(0, 300);
      return `${i + 1}. [${p.platform}] Author: ${author || 'unknown'}\n   ${text}`;
    }).join('\n\n');

    const icpSection = icpContext
      ? `The client sells to businesses matching this profile:\n${icpContext}`
      : 'Extract any businesses that appear to be real companies (not individuals or platforms).';

    const excludeSection = excludeDomains.length || excludeKeywords.length
      ? `\nEXCLUDE these known competitors/companies:\n${[...excludeDomains, ...excludeKeywords].join(', ')}`
      : '';

    const prompt = `You are extracting potential target companies from social media posts.

${icpSection}${excludeSection}

From these social media posts, extract any businesses that could be potential customers:

${postSummary}

For each business found, provide:
- name: the business name
- website: domain if mentioned or inferrable (omit if unknown)
- city: location if mentioned (omit if unknown)
- source: "author" if the post author works at or owns the company, or "mention" if named in the post text
- reasoning: one sentence on why they match

Return ONLY valid JSON: [{"name": "...", "website": "...", "city": "...", "source": "...", "reasoning": "..."}]
Return [] if none found.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content.find(b => b.type === 'text')?.text ?? '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return result;

      const extracted = JSON.parse(jsonMatch[0]) as Array<{
        name: string;
        website?: string;
        city?: string;
        source?: string;
        reasoning?: string;
      }>;
      result.companiesFound = extracted.length;

      for (const biz of extracted) {
        if (!biz.name) continue;
        const nameLower = biz.name.toLowerCase();
        // Skip excluded keywords
        if (excludeKeywords.some(k => nameLower.includes(k))) continue;
        // Skip excluded domains
        if (biz.website && excludeDomains.includes(biz.website.toLowerCase())) continue;
        // Skip blocked platform names/domains
        if (isBlockedCompanyName(biz.name)) continue;
        if (biz.website && isBlockedDomain(biz.website)) continue;
        // Dedup against existing
        if (existingNames.has(nameLower)) continue;
        if (biz.website && existingDomains.has(biz.website.toLowerCase())) continue;

        const company: UnifiedCompany = {
          name: biz.name,
          domain: biz.website,
          websiteUrl: biz.website ? `https://${biz.website}` : undefined,
          city: biz.city,
          description: biz.reasoning,
          externalIds: {},
        };

        await this.upsertDiscoveredCompanyWithSource(params.clientId, company, 'social_discovery');
        if (biz.website) existingDomains.add(biz.website.toLowerCase());
        existingNames.add(nameLower);
        result.companiesAdded++;
      }
    } catch (err) {
      log.error({ err }, 'LLM social post analysis failed');
    }

    log.info(result, 'Social-based company discovery complete');
    return result;
  }

  /**
   * Upsert a discovered company with a named source string.
   * Delegates to the existing upsertDiscoveredCompany logic but accepts a source label.
   */
  private async upsertDiscoveredCompanyWithSource(
    clientId: string,
    data: UnifiedCompany,
    source: string,
  ): Promise<{ id: string }> {
    // Tag the externalId so upsertDiscoveredCompany picks up the right source name
    const tagged: UnifiedCompany = {
      ...data,
      externalIds: { ...data.externalIds, [source]: data.domain ?? data.name ?? 'discovered' },
    };
    return this.upsertDiscoveredCompanyTagged(clientId, tagged, source);
  }

  private async upsertDiscoveredCompanyTagged(
    clientId: string,
    data: UnifiedCompany,
    source: string,
  ): Promise<{ id: string }> {
    const db = getDb();
    const now = new Date();

    const dbFields = {
      name: data.name,
      domain: data.domain,
      linkedinUrl: data.linkedinUrl,
      websiteUrl: data.websiteUrl,
      industry: data.industry,
      employeeCount: data.employeeCount,
      employeeRange: data.employeeRange,
      city: data.city,
      state: data.state,
      country: data.country,
      address: data.address,
      description: data.description,
      phone: data.phone,
      techStack: [] as string[],
      sources: [{ source, fetchedAt: now.toISOString(), fieldsProvided: [] }] as SourceRecord[],
      primarySource: source,
      updatedAt: now,
    };

    if (data.domain) {
      const existing = await db
        .select({ id: schema.companies.id, sources: schema.companies.sources })
        .from(schema.companies)
        .where(and(eq(schema.companies.clientId, clientId), eq(schema.companies.domain, data.domain)))
        .limit(1);

      if (existing.length > 0) {
        const existingSources: SourceRecord[] = (existing[0].sources as SourceRecord[] | null) ?? [];
        if (!existingSources.some(s => s.source === source)) {
          const newSource: SourceRecord = { source, fetchedAt: now.toISOString(), fieldsProvided: [] };
          await db.update(schema.companies)
            .set({
              sources: [...existingSources, newSource],
              updatedAt: now,
            })
            .where(eq(schema.companies.id, existing[0].id));
        }
        return existing[0];
      }
    }

    const [inserted] = await db
      .insert(schema.companies)
      .values({ clientId, pipelineStage: 'tam', ...dbFields })
      .returning({ id: schema.companies.id });
    return inserted;
  }

  async discoverAndPopulate(params: {
    clientId: string;
    icpId: string;
    personaId?: string;
    limit?: number;
    jobId?: string;
    /** Override provider search order (names must match registered provider names) */
    providerOrder?: string[];
  }): Promise<DiscoveryResult> {
    const db = getDb();
    const limit = params.limit ?? 100;
    const warnings: string[] = [];

    // 1. Load ICP
    const [icp] = await db
      .select()
      .from(schema.icps)
      .where(eq(schema.icps.id, params.icpId));
    if (!icp) throw new Error(`ICP not found: ${params.icpId}`);

    const filters = icp.filters as IcpFilters;
    let providerHints = (icp.providerHints as ProviderSearchHints | null) ?? filters.providerHints;

    // Auto-generate provider hints from filters if none exist.
    // Without hints, search providers (e.g. Exa) have no semantic query to work with.
    if (!providerHints || (!providerHints.semanticSearchQuery && !providerHints.keywordSearchTerms?.length)) {
      const parts: string[] = [];
      if (filters.industries?.length) parts.push(filters.industries.join(', '));
      if (filters.keywords?.length) parts.push(filters.keywords.join(', '));
      if (filters.countries?.length) parts.push(`in ${filters.countries.join(', ')}`);
      if (filters.employeeCountMin || filters.employeeCountMax) {
        parts.push(`${filters.employeeCountMin ?? 1}-${filters.employeeCountMax ?? '10000+'} employees`);
      }
      if (parts.length > 0) {
        providerHints = {
          ...providerHints,
          semanticSearchQuery: `Companies in ${parts.join(', ')}`,
          keywordSearchTerms: [...(filters.industries ?? []), ...(filters.keywords ?? [])],
        };
        logger.info({ icpId: params.icpId, generatedHints: providerHints }, 'Auto-generated provider hints from ICP filters');
      }
    }

    // 2. Translate IcpFilters → CompanySearchParams
    const searchParams = this.buildSearchParams(filters, providerHints, limit);

    logger.info(
      { icpId: params.icpId, searchParams, limit },
      'Starting company discovery',
    );

    // Update job status to running
    if (params.jobId) {
      await db
        .update(schema.jobs)
        .set({ status: 'running', startedAt: new Date() })
        .where(eq(schema.jobs.id, params.jobId));
    }

    // 3. Search providers
    const { result: discovered, providersUsed, totalCost, skippedDueToCredits } =
      await this.orchestrator.searchCompanies(params.clientId, searchParams, {
        ...(params.providerOrder?.length && {
          providerOverride: params.providerOrder,
          maxProviders: params.providerOrder.length,
        }),
      });

    let companies = (discovered ?? []).filter(c => !isBlockedDomain(c.domain) && !isBlockedCompanyName(c.name));
    const blockedCount = (discovered?.length ?? 0) - companies.length;
    if (blockedCount > 0) {
      logger.info({ blockedCount }, 'Filtered out companies with blocked domains (social/platform sites)');
    }
    logger.info(
      { count: companies.length, providersUsed, totalCost, skippedDueToCredits },
      'Companies discovered from providers',
    );

    if (skippedDueToCredits && skippedDueToCredits > 0) {
      warnings.push(`${skippedDueToCredits} data provider(s) skipped due to insufficient credits. Add credits in Settings to use provider-powered discovery.`);
    }

    // 3b. Fallback: if no search providers returned results, use AI to suggest companies
    // then try to enrich via providers (if credits available), otherwise use AI data as-is
    if (companies.length === 0) {
      logger.warn(
        { providersUsed, skippedDueToCredits },
        'No companies from provider search — falling back to AI-powered discovery',
      );
      if (params.jobId) {
        await db
          .update(schema.jobs)
          .set({ output: { phase: 'ai_discovery', warnings }, updatedAt: new Date() })
          .where(eq(schema.jobs.id, params.jobId));
      }

      const aiCompanies = await this.discoverViaAI(filters, providerHints, limit);
      if (aiCompanies.length > 0) {
        // Try to enrich each AI-suggested company via providers for better data
        const enriched: UnifiedCompany[] = [];
        const unenriched: UnifiedCompany[] = [];
        for (const suggestion of aiCompanies) {
          if (!suggestion.domain) continue;
          try {
            const { result } = await this.orchestrator.enrichCompany(
              params.clientId,
              { domain: suggestion.domain, name: suggestion.name },
            );
            if (result) {
              enriched.push(result);
              continue;
            }
          } catch (err) {
            logger.debug({ domain: suggestion.domain, error: err }, 'Failed to enrich AI-suggested company');
          }
          // Enrichment failed or was skipped (e.g. no credits) — use AI data as-is
          unenriched.push({
            name: suggestion.name,
            domain: suggestion.domain,
            websiteUrl: `https://${suggestion.domain}`,
            externalIds: {},
          });
        }
        companies = [...enriched, ...unenriched];
        if (!providersUsed.includes('ai_discovery')) providersUsed.push('ai_discovery');
        logger.info(
          { suggested: aiCompanies.length, enriched: enriched.length, unenriched: unenriched.length },
          'AI discovery complete',
        );
      }
    }

    if (companies.length === 0) {
      warnings.push('No companies found from any source. Check your ICP filters and credit balance.');
      if (params.jobId) {
        await db
          .update(schema.jobs)
          .set({
            processedItems: 0,
            totalItems: 0,
            output: { companiesDiscovered: 0, companiesAdded: 0, warnings },
          })
          .where(eq(schema.jobs.id, params.jobId));
      }
      return {
        companiesDiscovered: 0,
        companiesScored: 0,
        companiesAdded: 0,
        contactsFound: 0,
        providersUsed,
        totalCost,
        warnings,
        newCompanyIds: [],
      };
    }

    // 4. Filter out non-company results (directories, review sites, associations)
    {
      const before = companies.length;
      companies = companies.filter(c => isPlausibleCompany(c));
      if (before > companies.length) {
        logger.info({ filtered: before - companies.length }, 'Filtered non-company results');
      }
    }

    // 5. Apply ICP exclusion filters
    const excludedDomains = new Set(
      (filters.excludeDomains ?? []).map(d => d.toLowerCase().replace(/^www\./, '')),
    );
    if (excludedDomains.size > 0) {
      const before = companies.length;
      companies = companies.filter(c => {
        if (!c.domain) return true;
        return !excludedDomains.has(c.domain.toLowerCase().replace(/^www\./, ''));
      });
      if (before > companies.length) {
        logger.info({ excluded: before - companies.length }, 'Filtered companies by ICP excludeDomains');
      }
    }

    // Apply excludeIndustries if set
    if (filters.excludeIndustries?.length) {
      const before = companies.length;
      const lowerExclude = filters.excludeIndustries.map(i => i.toLowerCase());
      companies = companies.filter(c => {
        if (!c.industry) return true; // Keep companies with unknown industry
        const ci = c.industry.toLowerCase();
        return !lowerExclude.some(ex => ci.includes(ex) || ex.includes(ci));
      });
      if (before > companies.length) {
        logger.info({ excluded: before - companies.length }, 'Filtered companies by ICP excludeIndustries');
      }
    }

    // 6. Enrich sparse companies BEFORE upsert so DB gets enriched data.
    // Companies from Exa only have name + domain — enrich via Apollo to get
    // industry, employee count, country etc. for proper scoring and display.
    const sparseCompanies = companies.filter(c =>
      c.domain && !c.industry && !c.employeeCount && !c.country,
    );
    if (sparseCompanies.length > 0) {
      const enrichLimit = Math.min(sparseCompanies.length, limit);
      logger.info(
        { sparse: sparseCompanies.length, enriching: enrichLimit },
        'Enriching sparse companies before upsert',
      );

      if (params.jobId) {
        await db
          .update(schema.jobs)
          .set({ output: { phase: 'enriching_sparse', sparseCount: sparseCompanies.length, warnings }, updatedAt: new Date() })
          .where(eq(schema.jobs.id, params.jobId));
      }

      let enriched = 0;
      for (const company of sparseCompanies.slice(0, enrichLimit)) {
        try {
          const { result: enrichedData, providersUsed: enrichProviders } = await this.orchestrator.enrichCompany(
            params.clientId,
            { domain: company.domain, name: company.name },
          );
          if (enrichedData) {
            if (enrichedData.name && !company.externalIds.exa) company.name = enrichedData.name;
            if (enrichedData.industry && !company.industry) company.industry = enrichedData.industry;
            if (enrichedData.employeeCount && !company.employeeCount) company.employeeCount = enrichedData.employeeCount;
            if (enrichedData.country && !company.country) company.country = enrichedData.country;
            if (enrichedData.annualRevenue && !company.annualRevenue) company.annualRevenue = enrichedData.annualRevenue;
            if (enrichedData.foundedYear && !company.foundedYear) company.foundedYear = enrichedData.foundedYear;
            if (enrichedData.latestFundingStage && !company.latestFundingStage) company.latestFundingStage = enrichedData.latestFundingStage;
            if (enrichedData.techStack?.length && !company.techStack?.length) company.techStack = enrichedData.techStack;
            if (enrichedData.employeeRange && !company.employeeRange) company.employeeRange = enrichedData.employeeRange;
            if (enrichedData.description && !company.description) company.description = enrichedData.description;
            if (enrichedData.city && !company.city) company.city = enrichedData.city;
            if (enrichedData.state && !company.state) company.state = enrichedData.state;
            if (enrichedData.linkedinUrl && !company.linkedinUrl) company.linkedinUrl = enrichedData.linkedinUrl;
            // Merge externalIds from enrichment provider
            Object.assign(company.externalIds, enrichedData.externalIds);
            enriched++;
          }
        } catch (err) {
          logger.debug({ domain: company.domain, error: err }, 'Failed to enrich sparse company');
        }
      }

      logger.info({ enriched, attempted: enrichLimit }, 'Sparse company enrichment complete');
    }

    // 7. Deduplicate against existing DB companies
    const existingDomains = new Set<string>();
    if (companies.some(c => c.domain)) {
      const existing = await db
        .select({ domain: schema.companies.domain })
        .from(schema.companies)
        .where(eq(schema.companies.clientId, params.clientId));
      for (const row of existing) {
        if (row.domain) existingDomains.add(row.domain.toLowerCase());
      }
    }

    const newCompanies = companies.filter(c => {
      if (!c.domain) return true;
      return !existingDomains.has(c.domain.toLowerCase());
    });

    logger.info(
      { total: companies.length, new: newCompanies.length, existing: companies.length - newCompanies.length },
      'Deduplication complete',
    );

    // Update job progress
    if (params.jobId) {
      await db
        .update(schema.jobs)
        .set({ totalItems: newCompanies.length, processedItems: 0, updatedAt: new Date() })
        .where(eq(schema.jobs.id, params.jobId));
    }

    // 8. Upsert discovered companies into DB (now with enriched data)
    const newCompanyIds: string[] = [];
    let upserted = 0;
    for (const company of newCompanies) {
      const { id: companyId } = await this.upsertDiscoveredCompany(params.clientId, company);
      newCompanyIds.push(companyId);
      upserted++;

      if (params.jobId && upserted % 10 === 0) {
        await db
          .update(schema.jobs)
          .set({ processedItems: upserted, updatedAt: new Date() })
          .where(eq(schema.jobs.id, params.jobId));
      }
    }

    // 9. Score all discovered companies (new + existing)
    // Note: these companies already matched provider search criteria so we use a low threshold
    const scoredCompanies = companies
      .map(c => ({ company: c, ...scoreCompanyFit(c, filters) }))
      .filter(c => c.score >= 0.2) // Low threshold — companies already matched provider search filters
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    logger.info(
      { discovered: companies.length, scored: scoredCompanies.length },
      'Scoring complete',
    );

    // 8. Optionally enrich top companies for better data (contacts, emails)
    const domainsToEnrich = scoredCompanies
      .filter(c => c.company.domain)
      .slice(0, Math.min(20, limit)) // Cap enrichment to 20 companies per build
      .map(c => c.company.domain!)
      .filter(d => !existingDomains.has(d.toLowerCase())); // Only enrich truly new companies

    let contactsFound = 0;
    if (domainsToEnrich.length > 0 && params.jobId) {
      // Load persona filters for contact discovery
      let personaFilters: { titlePatterns?: string[]; seniorityLevels?: string[]; departments?: string[] } | undefined;
      if (params.personaId) {
        const [persona] = await db
          .select()
          .from(schema.personas)
          .where(eq(schema.personas.id, params.personaId));
        if (persona) {
          personaFilters = {
            titlePatterns: persona.titlePatterns as string[],
            seniorityLevels: persona.seniorityLevels as string[],
            departments: persona.departments as string[],
          };
        }
      }

      await this.enrichment.enrichCompanies(
        params.clientId,
        domainsToEnrich,
        params.jobId,
        {
          discoverContacts: !!params.personaId,
          findEmails: !!params.personaId,
          verifyEmails: false, // Skip verification during build for speed
          personaFilters,
        },
      );

      // Count contacts found
      if (params.personaId) {
        for (const domain of domainsToEnrich) {
          const companyRows = await db
            .select({ id: schema.companies.id })
            .from(schema.companies)
            .where(and(eq(schema.companies.clientId, params.clientId), eq(schema.companies.domain, domain)))
            .limit(1);
          if (companyRows.length > 0) {
            const contacts = await db
              .select({ id: schema.contacts.id })
              .from(schema.contacts)
              .where(eq(schema.contacts.companyId, companyRows[0].id));
            contactsFound += contacts.length;
          }
        }
      }
    }

    return {
      companiesDiscovered: companies.length,
      companiesScored: scoredCompanies.length,
      companiesAdded: upserted,
      contactsFound,
      providersUsed,
      totalCost,
      warnings: warnings.length > 0 ? warnings : undefined,
      newCompanyIds,
    };
  }

  private buildSearchParams(
    filters: IcpFilters,
    hints: ProviderSearchHints | undefined,
    limit: number,
  ): CompanySearchParams {
    const params: CompanySearchParams = {
      limit: limit * 2, // Over-fetch to account for post-filtering and dedup
    };

    if (filters.industries?.length) params.industries = filters.industries;
    if (filters.employeeCountMin != null) params.employeeCountMin = filters.employeeCountMin;
    if (filters.employeeCountMax != null) params.employeeCountMax = filters.employeeCountMax;
    if (filters.revenueMin != null) params.revenueMin = filters.revenueMin;
    if (filters.revenueMax != null) params.revenueMax = filters.revenueMax;
    if (filters.fundingStages?.length) params.fundingStages = filters.fundingStages;
    if (filters.techStack?.length) params.techStack = filters.techStack;
    if (filters.countries?.length) params.countries = filters.countries;
    if (filters.states?.length) params.states = filters.states;
    if (filters.cities?.length) params.cities = filters.cities;

    // Pass semantic search query through for providers like Exa
    if (hints?.semanticSearchQuery) params.query = hints.semanticSearchQuery;

    // Merge keywords from both filters and provider hints
    const keywords: string[] = [];
    if (filters.keywords?.length) keywords.push(...filters.keywords);
    if (hints?.keywordSearchTerms?.length) keywords.push(...hints.keywordSearchTerms);
    if (keywords.length) params.keywords = [...new Set(keywords)];

    // Pass exclude filters through to providers (Apollo supports q_not_keywords)
    if (filters.excludeKeywords?.length) params.excludeKeywords = filters.excludeKeywords;
    if (filters.excludeIndustries?.length) params.excludeIndustries = filters.excludeIndustries;

    return params;
  }

  private async discoverViaAI(
    filters: IcpFilters,
    hints: ProviderSearchHints | undefined,
    limit: number,
  ): Promise<Array<{ name: string; domain: string }>> {
    const filterDesc: string[] = [];
    if (filters.industries?.length) filterDesc.push(`Industries: ${filters.industries.join(', ')}`);
    if (filters.employeeCountMin || filters.employeeCountMax)
      filterDesc.push(`Employees: ${filters.employeeCountMin ?? 'any'}-${filters.employeeCountMax ?? 'any'}`);
    if (filters.revenueMin || filters.revenueMax)
      filterDesc.push(`Revenue: $${filters.revenueMin ?? 0}-$${filters.revenueMax ?? 'any'}`);
    if (filters.countries?.length) filterDesc.push(`Countries: ${filters.countries.join(', ')}`);
    if (filters.states?.length) filterDesc.push(`States: ${filters.states.join(', ')}`);
    if (filters.cities?.length) filterDesc.push(`Cities: ${filters.cities.join(', ')}`);
    if (filters.techStack?.length) filterDesc.push(`Tech stack: ${filters.techStack.join(', ')}`);
    if (filters.fundingStages?.length) filterDesc.push(`Funding stages: ${filters.fundingStages.join(', ')}`);
    if (filters.keywords?.length) filterDesc.push(`Keywords: ${filters.keywords.join(', ')}`);
    if (hints?.keywordSearchTerms?.length) filterDesc.push(`Search terms: ${hints.keywordSearchTerms.join(', ')}`);

    let promptTemplate = AI_DISCOVERY_PROMPT;
    if (this.promptConfig) {
      try { promptTemplate = await this.promptConfig.getPrompt('discovery.ai.user'); } catch { /* use default */ }
    }
    const prompt = promptTemplate
      .replace('{{limit}}', String(Math.min(limit, 50)))
      .replace('{{filters}}', filterDesc.join('\n'));

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');

      // Extract JSON array from response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        logger.warn('AI discovery returned no parseable JSON');
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]) as Array<{ name: string; domain: string }>;
      const valid = parsed.filter(c => c.name && c.domain && !isBlockedDomain(c.domain));
      logger.info({ count: valid.length }, 'AI suggested companies');
      return valid;
    } catch (error) {
      logger.error({ error }, 'AI discovery failed');
      return [];
    }
  }

  private async upsertDiscoveredCompany(
    clientId: string,
    data: UnifiedCompany,
  ): Promise<{ id: string }> {
    const db = getDb();
    const now = new Date();

    // Infer which providers actually contributed data for THIS company
    const companySources: string[] = [];
    if (data.externalIds.apollo) companySources.push('apollo');
    if (data.externalIds.exa) companySources.push('exa');
    if (data.externalIds.leadmagic) companySources.push('leadmagic');
    if (companySources.length === 0) companySources.push('ai_discovery');

    const dbFields = {
      name: data.name,
      domain: data.domain,
      linkedinUrl: data.linkedinUrl,
      websiteUrl: data.websiteUrl,
      industry: data.industry,
      subIndustry: data.subIndustry,
      employeeCount: data.employeeCount,
      employeeRange: data.employeeRange,
      annualRevenue: data.annualRevenue != null ? String(data.annualRevenue) : undefined,
      foundedYear: data.foundedYear,
      totalFunding: data.totalFunding != null ? String(data.totalFunding) : undefined,
      latestFundingStage: data.latestFundingStage,
      city: data.city,
      state: data.state,
      country: data.country,
      address: data.address,
      techStack: data.techStack?.length ? data.techStack : undefined,
      logoUrl: data.logoUrl,
      description: data.description,
      phone: data.phone,
      sources: companySources.map(p => ({
        source: p,
        fetchedAt: now.toISOString(),
        fieldsProvided: [] as string[],
      })),
      primarySource: companySources[0],
      apolloId: data.externalIds.apollo,
      leadmagicId: data.externalIds.leadmagic,
      updatedAt: now,
    };

    // Dedupe by domain
    if (data.domain) {
      const existing = await db
        .select({ id: schema.companies.id })
        .from(schema.companies)
        .where(and(eq(schema.companies.clientId, clientId), eq(schema.companies.domain, data.domain)))
        .limit(1);

      if (existing.length > 0) {
        // Only update fields that have data — don't overwrite existing enriched fields with empty values
        const updateFields: Record<string, unknown> = { updatedAt: now };
        for (const [key, value] of Object.entries(dbFields)) {
          if (value !== undefined && value !== null && key !== 'updatedAt') {
            updateFields[key] = value;
          }
        }
        await db.update(schema.companies).set(updateFields).where(eq(schema.companies.id, existing[0].id));
        return existing[0];
      }
    }

    const [inserted] = await db
      .insert(schema.companies)
      .values({ clientId, ...dbFields, techStack: dbFields.techStack ?? [] })
      .returning({ id: schema.companies.id });
    return inserted;
  }
}
