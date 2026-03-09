import { BaseProvider } from '../base.js';
import type { DataProvider, ProviderCapability } from '../types.js';
import type { JinaReadResponse } from './types.js';
import { logger } from '../../lib/logger.js';

const CANDIDATE_PATHS = [
  '/about', '/about-us', '/company',
  '/products', '/services', '/solutions', '/platform',
  '/pricing',
];

const MAX_PAGES = 4;
const MAX_COMBINED_CHARS = 15_000;

export class JinaProvider extends BaseProvider implements Partial<DataProvider> {
  readonly name = 'jina';
  readonly displayName = 'Jina Reader';
  readonly capabilities: ProviderCapability[] = ['company_enrich'];

  constructor(apiKey: string) {
    super({
      apiKey,
      baseUrl: 'https://r.jina.ai',
      rateLimit: { perSecond: 20, perMinute: 500 },
    });
    this.log = logger.child({ provider: this.name });
  }

  protected getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'X-Return-Format': 'markdown',
    };
  }

  /**
   * Read a single URL and return its markdown content.
   * Returns null on 404 or other failures (non-throwing).
   */
  async readUrl(url: string): Promise<{ content: string; title?: string; tokensUsed: number } | null> {
    try {
      const response = await this.request<JinaReadResponse>('post', '', {
        body: { url },
        timeout: 45_000,
        retry: { limit: 2 },
      });
      if (!response.data?.content) return null;
      return {
        content: response.data.content,
        title: response.data.title,
        tokensUsed: response.data.usage?.tokens ?? 0,
      };
    } catch {
      // 404s, timeouts, etc. — non-fatal for page discovery
      return null;
    }
  }

  /**
   * Scrape key pages of a company website and return combined markdown.
   * Tries homepage + up to 3-4 informational pages.
   * Returns combined content capped at ~15k chars, plus total tokens consumed.
   */
  async scrapeCompanyWebsite(domain: string): Promise<{ content: string; tokensUsed: number; pagesScraped: number }> {
    const log = this.log.child({ domain });
    let totalTokens = 0;

    // Fire homepage + all candidate pages in parallel
    const allUrls = [
      { path: 'Homepage', url: `https://${domain}` },
      ...CANDIDATE_PATHS.map(p => ({ path: p, url: `https://${domain}${p}` })),
    ];

    const results = await Promise.allSettled(
      allUrls.map(({ url }) => this.readUrl(url)),
    );

    // Assemble sections in order, respecting page and char limits
    const sections: string[] = [];
    let totalChars = 0;
    let pagesScraped = 0;

    for (let i = 0; i < results.length; i++) {
      if (pagesScraped >= MAX_PAGES) break;
      if (totalChars >= MAX_COMBINED_CHARS) break;

      const settled = results[i];
      if (settled.status !== 'fulfilled' || !settled.value?.content) continue;
      // Skip sub-pages with very little content (likely 404 soft-pages)
      if (i > 0 && settled.value.content.length <= 200) continue;

      const maxChunk = i === 0 ? 5000 : Math.min(4000, MAX_COMBINED_CHARS - totalChars);
      const chunk = settled.value.content.slice(0, maxChunk);
      sections.push(`## ${allUrls[i].path}\n${chunk}`);
      totalChars += chunk.length;
      totalTokens += settled.value.tokensUsed;
      pagesScraped++;
      log.debug({ path: allUrls[i].path, chars: chunk.length, tokens: settled.value.tokensUsed }, 'Scraped page');
    }

    log.info({ pages: pagesScraped, totalChars, totalTokens }, 'Website scrape complete');
    return { content: sections.join('\n\n'), tokensUsed: totalTokens, pagesScraped };
  }
}
