import { BaseProvider } from '../base.js';
import type {
  DataProvider,
  ProviderCapability,
  CompanySearchParams,
  CompanyEnrichParams,
  PeopleSearchParams,
  PeopleEnrichParams,
  UnifiedCompany,
  UnifiedContact,
  ProviderResponse,
  PaginatedResponse,
} from '../types.js';
import { mapApolloOrganization, mapApolloPerson } from './mappers.js';
import type {
  ApolloOrgEnrichResponse,
  ApolloPeopleSearchResponse,
  ApolloCompanySearchResponse,
  ApolloPersonEnrichResponse,
  ApolloApiSearchResponse,
  ApolloBulkMatchResponse,
} from './types.js';

export class ApolloProvider extends BaseProvider implements DataProvider {
  readonly name = 'apollo';
  readonly displayName = 'Apollo.io';
  readonly capabilities: ProviderCapability[] = [
    'company_search', 'company_enrich', 'people_search', 'people_enrich',
  ];

  constructor(apiKey: string) {
    super({
      apiKey,
      baseUrl: 'https://api.apollo.io/api/v1',
      rateLimit: { perSecond: 5, perMinute: 100 },
    });
    this.log = this.log.child({ provider: this.name });
  }

  protected getAuthHeaders(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  async searchCompanies(params: CompanySearchParams): Promise<PaginatedResponse<UnifiedCompany>> {
    try {
      const targetLimit = params.limit ?? 25;
      const maxPages = Math.min(Math.ceil(targetLimit / 100), 25); // safety cap: 2,500 results
      const allCompanies: UnifiedCompany[] = [];
      const seenDomains = new Set<string>();
      let totalEntries = 0;
      let totalPages = 0;
      const startPage = params.offset ? Math.floor(params.offset / 100) + 1 : 1;

      const body = this.buildSearchBody(params);

      for (let i = 0; i < maxPages; i++) {
        const pageNum = startPage + i;
        const raw = await this.request<ApolloCompanySearchResponse>(
          'post', '/mixed_companies/search', { body: { ...body, page: pageNum, per_page: 100 } },
        );

        totalEntries = raw.pagination.total_entries;
        totalPages = raw.pagination.total_pages;

        if (!raw.organizations?.length) break;

        for (const org of raw.organizations) {
          const company = mapApolloOrganization(org);
          const domain = company.domain?.toLowerCase();
          if (domain && seenDomains.has(domain)) continue;
          if (domain) seenDomains.add(domain);
          allCompanies.push(company);
        }

        this.log.info(
          { page: pageNum, totalPages, totalEntries, accumulated: allCompanies.length, targetLimit },
          'Apollo search page fetched',
        );

        if (allCompanies.length >= targetLimit) break;
        if (pageNum >= totalPages) break;
      }

      return {
        success: true,
        data: allCompanies,
        totalResults: totalEntries,
        hasMore: allCompanies.length < totalEntries,
        nextPageToken: startPage + Math.min(maxPages, totalPages),
        creditsConsumed: 0,
        fieldsPopulated: ['name', 'domain', 'industry'],
        qualityScore: 0.5,
      };
    } catch (error) {
      if (this.isPlanRestriction(error)) {
        this.log.warn('Company search requires a paid Apollo plan — skipping');
      } else {
        this.log.error({ error }, 'Company search failed');
      }
      return {
        success: false, data: [], totalResults: 0, hasMore: false,
        error: String(error), creditsConsumed: 0, fieldsPopulated: [], qualityScore: 0,
      };
    }
  }

  private buildSearchBody(params: CompanySearchParams): Record<string, unknown> {
    const body: Record<string, unknown> = {};

    if (params.industries?.length) body.organization_industries = params.industries;
    if (params.employeeCountMin != null || params.employeeCountMax != null) {
      body.organization_num_employees_ranges = buildEmployeeRanges(
        params.employeeCountMin, params.employeeCountMax,
      );
    }

    // Revenue and funding stage intentionally excluded — they over-constrain
    // Apollo searches. Post-discovery ICP scoring handles these dimensions.

    // Location filters: Apollo expects full country names, not ISO codes
    const locations: string[] = [];
    if (params.countries?.length) locations.push(...params.countries.map(expandCountryCode));
    if (params.states?.length) locations.push(...params.states);
    if (params.cities?.length) locations.push(...params.cities);
    if (locations.length) body.organization_locations = locations;

    // Use q_organization_keyword_tags (OR-based, relevance-ranked) instead of
    // q_keywords (freeform AND-like text search). Tags match Apollo's company-level
    // keyword taxonomy — more matching tags = higher relevance rank.
    if (params.keywords?.length) {
      body.q_organization_keyword_tags = params.keywords;
    }

    // Exclude keywords via q_not_keywords (negative freeform search)
    if (params.excludeKeywords?.length) {
      body.q_not_keywords = params.excludeKeywords.join(' ');
    }

    // Tech stack requires Apollo UIDs, not human-readable names — skipped.
    // Scoring handles tech stack matching post-discovery.

    return body;
  }

  async enrichCompany(params: CompanyEnrichParams): Promise<ProviderResponse<UnifiedCompany>> {
    try {
      const queryParams: Record<string, string> = {};
      if (params.domain) queryParams.domain = params.domain;

      const raw = await this.request<ApolloOrgEnrichResponse>(
        'get', '/organizations/enrich', { params: queryParams },
      );

      if (!raw.organization) {
        return {
          success: false, data: null, error: 'No organization found',
          creditsConsumed: 0, fieldsPopulated: [], qualityScore: 0,
        };
      }

      const unified = mapApolloOrganization(raw.organization);
      const fieldsPopulated = this.getPopulatedFields(unified as unknown as Record<string, unknown>);

      return {
        success: true,
        data: unified,
        creditsConsumed: raw.credits_consumed ?? 1,
        fieldsPopulated,
        qualityScore: Math.min(fieldsPopulated.length / 15, 1),
      };
    } catch (error) {
      this.log.error({ error, params }, 'Company enrichment failed');
      return {
        success: false, data: null, error: String(error),
        creditsConsumed: 0, fieldsPopulated: [], qualityScore: 0,
      };
    }
  }

  async searchPeople(params: PeopleSearchParams): Promise<PaginatedResponse<UnifiedContact>> {
    try {
      // Step 1: Search via api_search (returns obfuscated data + Apollo IDs)
      const searchBody: Record<string, unknown> = {
        per_page: Math.min(params.limit ?? 25, 100),
        page: params.offset ? Math.floor(params.offset / 100) + 1 : 1,
      };

      // api_search uses q_* prefixed parameters
      if (params.companyDomains?.length) {
        searchBody.q_organization_domains = params.companyDomains.join('\n');
      }
      if (params.titlePatterns?.length) searchBody.person_titles = params.titlePatterns;
      if (params.seniorityLevels?.length) searchBody.person_seniorities = params.seniorityLevels;
      if (params.departments?.length) searchBody.person_departments = params.departments;
      if (params.countries?.length) searchBody.person_locations = params.countries;

      const searchResult = await this.request<ApolloApiSearchResponse>(
        'post', '/mixed_people/api_search', { body: searchBody },
      );

      if (!searchResult.people?.length) {
        return {
          success: true, data: [], totalResults: 0, hasMore: false,
          creditsConsumed: 0, fieldsPopulated: [], qualityScore: 0,
        };
      }

      // Step 2: Enrich the found people via bulk_match to get full details
      const personIds = searchResult.people.map(p => p.id);
      const matchResult = await this.request<ApolloBulkMatchResponse>(
        'post', '/people/bulk_match', {
          body: { details: personIds.map(id => ({ id })) },
        },
      );

      const contacts = (matchResult.matches ?? [])
        .filter(m => m != null)
        .map(mapApolloPerson);

      return {
        success: true,
        data: contacts,
        totalResults: searchResult.total_entries,
        hasMore: contacts.length >= (params.limit ?? 25),
        creditsConsumed: matchResult.credits_consumed ?? 0,
        fieldsPopulated: ['name', 'title', 'company', 'linkedin', 'seniority'],
        qualityScore: 0.7,
      };
    } catch (error) {
      if (this.isPlanRestriction(error)) {
        this.log.warn('People search requires a paid Apollo plan — skipping');
      } else {
        this.log.error({ error }, 'People search failed');
      }
      return {
        success: false, data: [], totalResults: 0, hasMore: false,
        error: String(error), creditsConsumed: 0, fieldsPopulated: [], qualityScore: 0,
      };
    }
  }

  async enrichPerson(params: PeopleEnrichParams): Promise<ProviderResponse<UnifiedContact>> {
    try {
      const body: Record<string, unknown> = {};
      if (params.firstName) body.first_name = params.firstName;
      if (params.lastName) body.last_name = params.lastName;
      if (params.email) body.email = params.email;
      if (params.linkedinUrl) body.linkedin_url = params.linkedinUrl;
      if (params.companyDomain) body.organization_domain = params.companyDomain;

      const raw = await this.request<ApolloPersonEnrichResponse>(
        'post', '/people/match', { body },
      );

      if (!raw.person) {
        return {
          success: false, data: null, error: 'No person found',
          creditsConsumed: 0, fieldsPopulated: [], qualityScore: 0,
        };
      }

      const unified = mapApolloPerson(raw.person);
      const fieldsPopulated = this.getPopulatedFields(unified as unknown as Record<string, unknown>);

      return {
        success: true,
        data: unified,
        creditsConsumed: raw.credits_consumed ?? 1,
        fieldsPopulated,
        qualityScore: Math.min(fieldsPopulated.length / 12, 1),
      };
    } catch (error) {
      this.log.error({ error, params }, 'Person enrichment failed');
      return {
        success: false, data: null, error: String(error),
        creditsConsumed: 0, fieldsPopulated: [], qualityScore: 0,
      };
    }
  }

  private isPlanRestriction(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.includes('403') || msg.includes('API_INACCESSIBLE') || msg.includes('free plan');
  }
}

/** Map common ISO country codes to full names for Apollo's location filter */
const COUNTRY_CODE_MAP: Record<string, string> = {
  us: 'United States',
  gb: 'United Kingdom',
  uk: 'United Kingdom',
  ca: 'Canada',
  au: 'Australia',
  de: 'Germany',
  fr: 'France',
  nl: 'Netherlands',
  ie: 'Ireland',
  se: 'Sweden',
  es: 'Spain',
  it: 'Italy',
  in: 'India',
  sg: 'Singapore',
  jp: 'Japan',
  kr: 'South Korea',
  br: 'Brazil',
  il: 'Israel',
  uae: 'United Arab Emirates',
  cn: 'China',
  nz: 'New Zealand',
};

function expandCountryCode(code: string): string {
  return COUNTRY_CODE_MAP[code.toLowerCase()] ?? code;
}

/**
 * Apollo expects employee count as predefined range buckets, not arbitrary min/max.
 * We select all buckets that overlap with the requested range.
 */
const EMPLOYEE_RANGE_BUCKETS = [
  [1, 10], [11, 20], [21, 50], [51, 100], [101, 200],
  [201, 500], [501, 1000], [1001, 2000], [2001, 5000],
  [5001, 10000],
] as const;

function buildEmployeeRanges(min?: number, max?: number): string[] {
  const lo = min ?? 1;
  const hi = max ?? Infinity;
  const ranges: string[] = [];
  for (const [bucketMin, bucketMax] of EMPLOYEE_RANGE_BUCKETS) {
    // Include bucket if it overlaps with the requested range
    if (bucketMax >= lo && bucketMin <= hi) {
      ranges.push(`${bucketMin},${bucketMax}`);
    }
  }
  // Handle 10001+ if the requested max is above 10000 or unbounded
  if (hi > 10000) {
    ranges.push('10001,1000000');
  }
  return ranges.length > 0 ? ranges : ['1,1000000'];
}

