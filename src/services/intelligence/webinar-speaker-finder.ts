import Anthropic from '@anthropic-ai/sdk';
import { getDb, schema } from '../../db/index.js';
import { eq, and } from 'drizzle-orm';
import type { WebinarAngle } from '../../db/schema/market-buzz.js';
import type { NewWebinarSpeaker, SocialProfile, SpeakerEvidence } from '../../db/schema/webinar-speakers.js';
import type { ExaProvider } from '../../providers/exa/index.js';
import type { ApifyProvider } from '../../providers/apify/index.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ service: 'webinar-speaker-finder' });

interface SpeakerCandidate {
  name: string;
  handle?: string;
  platform: 'linkedin' | 'twitter' | 'instagram' | 'youtube' | 'reddit' | 'other';
  profileUrl?: string;
  snippet: string;
  discoverySource: string;
  sourceUrl?: string;
}

interface ScoredSpeaker {
  rank: number;
  name: string;
  currentTitle?: string;
  company?: string;
  bio: string;
  relevanceScore: number;
  reachScore: number;
  primaryPlatform?: string;
  primaryProfileUrl?: string;
  socialProfiles: SocialProfile[];
  speakerReasoning: string;
  evidence: SpeakerEvidence[];
  outreachMessage: string;
}

export class WebinarSpeakerFinder {
  private anthropic: Anthropic;
  private exaProvider?: ExaProvider;
  private apifyProvider?: ApifyProvider;

  constructor(anthropicApiKey: string) {
    this.anthropic = new Anthropic({ apiKey: anthropicApiKey });
  }

  setExaProvider(p: ExaProvider) { this.exaProvider = p; }
  setApifyProvider(p: ApifyProvider) { this.apifyProvider = p; }

  async findSpeakers(
    clientId: string,
    buzzReportId: string,
    angleIndex: number,
    jobId: string,
  ): Promise<NewWebinarSpeaker[]> {
    const db = getDb();

    // 1. Load buzz report and extract the angle
    const [reportRow] = await db
      .select()
      .from(schema.buzzReports)
      .where(eq(schema.buzzReports.id, buzzReportId));

    if (!reportRow?.report) {
      throw new Error(`Buzz report ${buzzReportId} not found or has no data`);
    }

    const angle = reportRow.report.webinarAngles[angleIndex];
    if (!angle) {
      throw new Error(`No webinar angle at index ${angleIndex}`);
    }

    log.info({ buzzReportId, angleIndex, angleTitle: angle.title }, 'Starting speaker discovery');

    // 2. Generate search queries with Claude Haiku
    const queries = await this.generateSearchQueries(angle, clientId);
    log.info({ angleTitle: angle.title, queries }, 'Generated search queries');

    // 3. Run searches in parallel to find candidates
    const candidates = await this.discoverCandidates(queries, angle.title);
    log.info({ angleTitle: angle.title, candidateCount: candidates.length }, 'Discovered candidates');

    if (candidates.length === 0) {
      log.warn({ buzzReportId, angleIndex }, 'No candidates found for angle');
      return [];
    }

    // 4. Deduplicate by normalised name
    const unique = this.deduplicateCandidates(candidates);
    log.info({ angleTitle: angle.title, uniqueCount: unique.length }, 'Deduplicated candidates');

    // 5. Enrich candidates with current role/company via Exa
    const enriched = await this.enrichCandidates(unique);

    // 6. Score and rank with Claude Sonnet
    const scored = await this.scoreAndRankSpeakers(angle, enriched);
    log.info({ angleTitle: angle.title, scoredCount: scored.length }, 'Scored speakers');

    // 7. Map to DB rows
    const rows: NewWebinarSpeaker[] = scored.map((s, i) => {
      const matchedCandidate = enriched.find(
        (c) => c.name.toLowerCase() === s.name.toLowerCase(),
      ) ?? enriched[i];

      return {
        clientId,
        buzzReportId,
        angleIndex,
        angleTitle: angle.title,
        name: s.name,
        currentTitle: s.currentTitle ?? null,
        company: s.company ?? null,
        bio: s.bio,
        socialProfiles: s.socialProfiles,
        primaryPlatform: s.primaryPlatform ?? matchedCandidate?.platform ?? null,
        primaryProfileUrl: s.primaryProfileUrl ?? matchedCandidate?.profileUrl ?? null,
        relevanceScore: String(s.relevanceScore),
        reachScore: String(s.reachScore),
        overallRank: s.rank,
        speakerReasoning: s.speakerReasoning,
        evidence: s.evidence,
        outreachMessage: s.outreachMessage,
        discoverySource: matchedCandidate?.discoverySource ?? null,
        sourceUrl: matchedCandidate?.sourceUrl ?? null,
        jobId,
        status: 'completed',
      };
    });

    // 8. Persist (replace any existing for this report+angle)
    await db
      .delete(schema.webinarSpeakers)
      .where(
        and(
          eq(schema.webinarSpeakers.buzzReportId, buzzReportId),
          eq(schema.webinarSpeakers.angleIndex, angleIndex),
        ),
      );

    if (rows.length > 0) {
      await db.insert(schema.webinarSpeakers).values(rows);
    }

    log.info({ buzzReportId, angleIndex, count: rows.length }, 'Persisted speakers');
    return rows;
  }

  private async generateSearchQueries(angle: WebinarAngle, _clientId: string): Promise<string[]> {
    const prompt = `You are building a speaker list for a webinar titled: "${angle.title}"

Topic description: ${angle.description}
Key talking points: ${angle.talkingPoints.join(', ')}
Target audience: ${angle.targetSegments.join(', ')}

Generate 6 search queries to find people who:
- Publicly talk about this topic on social media or in articles
- Have a relevant professional background
- Have a credible audience or following

Keep each query concise (5-10 words). Focus on content creators, industry experts, founders, consultants, and practitioners in this space.

Return ONLY valid JSON: { "queries": ["...", "...", "...", "...", "...", "..."] }`;

    const message = await this.anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].type === 'text' ? message.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return this.fallbackQueries(angle);

    try {
      const parsed = JSON.parse(jsonMatch[0]) as { queries?: string[] };
      return parsed.queries?.slice(0, 6) ?? this.fallbackQueries(angle);
    } catch {
      return this.fallbackQueries(angle);
    }
  }

  private fallbackQueries(angle: WebinarAngle): string[] {
    const title = angle.title;
    return [
      `${title} expert speaker`,
      `${title} thought leader`,
      `${angle.talkingPoints[0] ?? title} practitioner`,
      `${angle.targetSegments[0] ?? ''} ${title} consultant`,
    ].filter(Boolean);
  }

  private async discoverCandidates(queries: string[], angleTitle: string): Promise<SpeakerCandidate[]> {
    const candidates: SpeakerCandidate[] = [];

    const searches: Promise<SpeakerCandidate[]>[] = [];

    if (this.exaProvider) {
      // Tweet searches (first 3 queries)
      for (const query of queries.slice(0, 3)) {
        searches.push(this.searchTweets(query));
      }
      // LinkedIn domain searches (next 2 queries)
      for (const query of queries.slice(3, 5)) {
        searches.push(this.searchLinkedIn(query));
      }
    }

    if (this.apifyProvider) {
      // Apify LinkedIn post search (last query or first)
      const apifyQuery = queries[5] ?? queries[0];
      searches.push(this.searchApifyLinkedIn(apifyQuery));
    }

    const results = await Promise.allSettled(searches);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        candidates.push(...result.value);
      } else {
        log.warn({ angleTitle, error: result.reason }, 'Search failed');
      }
    }

    return candidates;
  }

  private async searchTweets(query: string): Promise<SpeakerCandidate[]> {
    if (!this.exaProvider) return [];
    try {
      const response = await this.exaProvider.searchNews({
        query,
        numResults: 8,
        category: 'tweet',
      });
      return response.results
        .filter((r) => r.author || r.url?.includes('twitter.com') || r.url?.includes('x.com'))
        .map((r) => {
          const handle = r.author ?? extractTwitterHandle(r.url ?? '');
          return {
            name: handle ?? r.author ?? 'Unknown',
            handle,
            platform: 'twitter' as const,
            profileUrl: handle ? `https://twitter.com/${handle.replace('@', '')}` : r.url,
            snippet: r.text?.slice(0, 300) ?? r.title ?? '',
            discoverySource: 'exa_tweet',
            sourceUrl: r.url,
          };
        })
        .filter((c) => c.name !== 'Unknown');
    } catch (err) {
      log.warn({ query, error: err }, 'Tweet search failed');
      return [];
    }
  }

  private async searchLinkedIn(query: string): Promise<SpeakerCandidate[]> {
    if (!this.exaProvider) return [];
    try {
      const results = await this.exaProvider.searchWithDomains(
        query,
        ['linkedin.com'],
        8,
      );
      return results
        .filter((r) => r.author || r.url?.includes('/in/') || r.url?.includes('/posts/'))
        .map((r) => ({
          name: r.author ?? extractLinkedInName(r.url ?? '') ?? 'Unknown',
          platform: 'linkedin' as const,
          profileUrl: r.url?.includes('/in/') ? r.url : undefined,
          snippet: r.text?.slice(0, 300) ?? r.title ?? '',
          discoverySource: 'exa_linkedin',
          sourceUrl: r.url,
        }))
        .filter((c) => c.name !== 'Unknown');
    } catch (err) {
      log.warn({ query, error: err }, 'LinkedIn search failed');
      return [];
    }
  }

  private async searchApifyLinkedIn(query: string): Promise<SpeakerCandidate[]> {
    if (!this.apifyProvider) return [];
    try {
      const posts = await this.apifyProvider.searchSocialPosts({
        platform: 'linkedin',
        keywords: [query],
        limit: 15,
      });
      return posts
        .filter((p) => p.authorName || p.authorHandle)
        .map((p) => ({
          name: p.authorName ?? p.authorHandle ?? 'Unknown',
          handle: p.authorHandle,
          platform: 'linkedin' as const,
          profileUrl: p.url?.includes('/in/') ? p.url : undefined,
          snippet: p.text?.slice(0, 300) ?? '',
          discoverySource: 'apify_linkedin',
          sourceUrl: p.url,
        }))
        .filter((c) => c.name !== 'Unknown');
    } catch (err) {
      log.warn({ query, error: err }, 'Apify LinkedIn search failed');
      return [];
    }
  }

  private deduplicateCandidates(candidates: SpeakerCandidate[]): SpeakerCandidate[] {
    const seen = new Map<string, SpeakerCandidate>();
    for (const c of candidates) {
      const key = normalizeName(c.name);
      if (key.length < 3) continue;
      if (!seen.has(key)) {
        seen.set(key, c);
      } else {
        // Prefer entries with a profile URL
        const existing = seen.get(key)!;
        if (!existing.profileUrl && c.profileUrl) {
          seen.set(key, { ...existing, profileUrl: c.profileUrl });
        }
      }
    }
    return Array.from(seen.values()).slice(0, 30);
  }

  private async enrichCandidates(candidates: SpeakerCandidate[]): Promise<SpeakerCandidate[]> {
    if (!this.exaProvider) return candidates;

    // Enrich up to 20 candidates (to keep Exa costs reasonable)
    const toEnrich = candidates.slice(0, 20);
    const enriched = await Promise.allSettled(
      toEnrich.map(async (c) => {
        if (c.profileUrl) return c; // Already have a profile URL
        try {
          const results = await this.exaProvider!.searchWithDomains(
            c.name,
            ['linkedin.com', 'twitter.com', 'x.com'],
            2,
          );
          if (results.length > 0) {
            const r = results[0];
            return {
              ...c,
              profileUrl: c.profileUrl ?? r.url,
              snippet: c.snippet || r.text?.slice(0, 300) || c.snippet,
            };
          }
        } catch {
          // Ignore enrichment failures
        }
        return c;
      }),
    );

    return enriched.map((r) => (r.status === 'fulfilled' ? r.value : candidates[0]));
  }

  private async scoreAndRankSpeakers(
    angle: WebinarAngle,
    candidates: SpeakerCandidate[],
  ): Promise<ScoredSpeaker[]> {
    if (candidates.length === 0) return [];

    const candidateList = candidates
      .map(
        (c, i) =>
          `${i + 1}. ${c.name} (${c.platform})` +
          (c.profileUrl ? ` — ${c.profileUrl}` : '') +
          `\n   Content: ${c.snippet.slice(0, 200)}`,
      )
      .join('\n\n');

    const prompt = `You are curating a panel of speakers for a webinar titled: "${angle.title}"

Webinar description: ${angle.description}
Key talking points: ${angle.talkingPoints.join('; ')}
Target audience: ${angle.targetSegments.join(', ')}
Trend connection: ${angle.trendConnection}

Here are candidate speakers discovered from social media and content:

${candidateList}

For each candidate, assess:
- RELEVANCE: How directly they address this exact topic (0.0–1.0)
- REACH: Their credibility signals — audience size, seniority, publication history (0.0–1.0)

Select and rank the best 10–15 speakers. Only include people who clearly have expertise or a public voice on this topic. Exclude vague or generic entries.

For each selected speaker write:
- bio: 2-sentence professional summary (infer from their content/handle)
- currentTitle: Their likely current role (e.g. "Founder, TechCorp" or "VP Marketing")
- company: Their likely company or organisation
- speaker_reasoning: 2-3 sentences on exactly why they'd be compelling for THIS webinar
- evidence: 2 specific posts/signals that show their engagement with the topic
- outreach_message: A personalised ~80-word invite referencing their actual content

Return ONLY valid JSON array (no extra text):
[{
  "rank": 1,
  "name": "...",
  "currentTitle": "...",
  "company": "...",
  "bio": "...",
  "relevanceScore": 0.9,
  "reachScore": 0.7,
  "primaryPlatform": "linkedin",
  "primaryProfileUrl": "https://...",
  "socialProfiles": [{"platform": "linkedin", "handle": "...", "url": "https://..."}],
  "speaker_reasoning": "...",
  "evidence": [{"text": "...", "url": "https://..."}],
  "outreach_message": "..."
}]`;

    try {
      const message = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = message.content[0].type === 'text' ? message.content[0].text : '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        log.warn({ angleTitle: angle.title }, 'No JSON array in speaker scoring response');
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        rank: number;
        name: string;
        currentTitle?: string;
        company?: string;
        bio: string;
        relevanceScore: number;
        reachScore: number;
        primaryPlatform?: string;
        primaryProfileUrl?: string;
        socialProfiles?: SocialProfile[];
        speaker_reasoning: string;
        evidence?: Array<{ text: string; url: string }>;
        outreach_message: string;
      }>;

      return parsed.map((s) => ({
        rank: s.rank,
        name: s.name,
        currentTitle: s.currentTitle,
        company: s.company,
        bio: s.bio,
        relevanceScore: Math.min(1, Math.max(0, s.relevanceScore)),
        reachScore: Math.min(1, Math.max(0, s.reachScore)),
        primaryPlatform: s.primaryPlatform,
        primaryProfileUrl: s.primaryProfileUrl,
        socialProfiles: s.socialProfiles ?? [],
        speakerReasoning: s.speaker_reasoning,
        evidence: (s.evidence ?? []).map((e) => ({ text: e.text, url: e.url })),
        outreachMessage: s.outreach_message,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? { message: err.message, name: err.name, stack: err.stack?.split('\n')[0] } : err;
      log.error({ angleTitle: angle.title, error: errMsg }, 'Speaker scoring failed');
      return [];
    }
  }

  async getSpeakers(buzzReportId: string, angleIndex: number): Promise<typeof schema.webinarSpeakers.$inferSelect[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.webinarSpeakers)
      .where(
        and(
          eq(schema.webinarSpeakers.buzzReportId, buzzReportId),
          eq(schema.webinarSpeakers.angleIndex, angleIndex),
        ),
      )
      .orderBy(schema.webinarSpeakers.overallRank);
  }

  async getSpeakersByReport(buzzReportId: string): Promise<typeof schema.webinarSpeakers.$inferSelect[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.webinarSpeakers)
      .where(eq(schema.webinarSpeakers.buzzReportId, buzzReportId))
      .orderBy(schema.webinarSpeakers.angleIndex, schema.webinarSpeakers.overallRank);
  }

  async deleteSpeaker(speakerId: string): Promise<void> {
    const db = getDb();
    await db.delete(schema.webinarSpeakers).where(eq(schema.webinarSpeakers.id, speakerId));
  }

  async clearAngleSpeakers(buzzReportId: string, angleIndex: number): Promise<void> {
    const db = getDb();
    await db
      .delete(schema.webinarSpeakers)
      .where(
        and(
          eq(schema.webinarSpeakers.buzzReportId, buzzReportId),
          eq(schema.webinarSpeakers.angleIndex, angleIndex),
        ),
      );
  }
}

// ── Helpers ──

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTwitterHandle(url: string): string | undefined {
  const m = url.match(/(?:twitter\.com|x\.com)\/(@?[A-Za-z0-9_]+)/);
  if (m && m[1] && !['search', 'intent', 'status', 'i', 'home'].includes(m[1])) {
    return `@${m[1].replace('@', '')}`;
  }
  return undefined;
}

function extractLinkedInName(url: string): string | undefined {
  const m = url.match(/linkedin\.com\/in\/([^/?]+)/);
  if (m && m[1]) {
    // Convert slug like "john-doe-123abc" to "John Doe"
    return m[1]
      .replace(/-[a-z0-9]{6,}$/, '') // strip trailing ID
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return undefined;
}
