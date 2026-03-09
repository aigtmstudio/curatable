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

      let body = this.buildSearchBody(params);

      this.log.info({ searchBody: body, targetLimit, maxPages }, 'Apollo search starting');

      // Fetch first page to check if q_organization_keyword_tags works
      const firstRaw = await this.request<ApolloCompanySearchResponse>(
        'post', '/mixed_companies/search', { body: { ...body, page: startPage, per_page: 100 } },
      );

      totalEntries = firstRaw.pagination.total_entries;
      totalPages = firstRaw.pagination.total_pages;

      // If keyword tags returned very few results, fall back to q_keywords (freeform)
      // This handles cases where the ICP keywords don't match Apollo's taxonomy tags
      if (totalEntries < targetLimit && body.q_organization_keyword_tags) {
        const allKeywords = body.q_organization_keyword_tags as string[];
        this.log.info(
          { totalEntries, targetLimit, keywords: allKeywords },
          'q_organization_keyword_tags returned few results, retrying with q_keywords (freeform)',
        );
        delete body.q_organization_keyword_tags;
        body.q_keywords = allKeywords.join('\n');

        const retryRaw = await this.request<ApolloCompanySearchResponse>(
          'post', '/mixed_companies/search', { body: { ...body, page: startPage, per_page: 100 } },
        );

        // Use whichever approach found more results
        if (retryRaw.pagination.total_entries > totalEntries) {
          this.log.info(
            { tagResults: totalEntries, keywordResults: retryRaw.pagination.total_entries },
            'q_keywords returned more results — using freeform keyword search',
          );
          totalEntries = retryRaw.pagination.total_entries;
          totalPages = retryRaw.pagination.total_pages;
          for (const org of retryRaw.organizations ?? []) {
            const company = mapApolloOrganization(org);
            const domain = company.domain?.toLowerCase();
            if (domain && seenDomains.has(domain)) continue;
            if (domain) seenDomains.add(domain);
            allCompanies.push(company);
          }
        } else if (totalEntries === 0) {
          // Both keyword approaches returned 0 — drop keywords entirely
          // and search by location + employee count only. ICP scoring will
          // filter for relevance post-fetch.
          this.log.info('Both keyword approaches returned 0, searching without keywords');
          delete body.q_keywords;
          const broadRaw = await this.request<ApolloCompanySearchResponse>(
            'post', '/mixed_companies/search', { body: { ...body, page: startPage, per_page: 100 } },
          );
          if (broadRaw.pagination.total_entries > 0) {
            this.log.info(
              { broadResults: broadRaw.pagination.total_entries },
              'Broad search (no keywords) returning results — ICP scoring will filter',
            );
            totalEntries = broadRaw.pagination.total_entries;
            totalPages = broadRaw.pagination.total_pages;
            for (const org of broadRaw.organizations ?? []) {
              const company = mapApolloOrganization(org);
              const domain = company.domain?.toLowerCase();
              if (domain && seenDomains.has(domain)) continue;
              if (domain) seenDomains.add(domain);
              allCompanies.push(company);
            }
          }
        } else {
          // Tag search was better or equal, use original first page
          body = this.buildSearchBody(params); // restore original body
          for (const org of firstRaw.organizations ?? []) {
            const company = mapApolloOrganization(org);
            const domain = company.domain?.toLowerCase();
            if (domain && seenDomains.has(domain)) continue;
            if (domain) seenDomains.add(domain);
            allCompanies.push(company);
          }
        }
      } else {
        // First page was good, accumulate results
        for (const org of firstRaw.organizations ?? []) {
          const company = mapApolloOrganization(org);
          const domain = company.domain?.toLowerCase();
          if (domain && seenDomains.has(domain)) continue;
          if (domain) seenDomains.add(domain);
          allCompanies.push(company);
        }
      }

      this.log.info(
        { page: startPage, totalPages, totalEntries, accumulated: allCompanies.length, targetLimit },
        'Apollo search page 1 fetched',
      );

      // Fetch remaining pages
      for (let i = 1; i < maxPages; i++) {
        if (allCompanies.length >= targetLimit) break;

        const pageNum = startPage + i;
        if (pageNum > totalPages) break;

        const raw = await this.request<ApolloCompanySearchResponse>(
          'post', '/mixed_companies/search', { body: { ...body, page: pageNum, per_page: 100 } },
        );

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

    // Split ICP industries into valid Apollo taxonomy values (hard filter) vs
    // non-standard terms (soft keyword tags). Apollo's organization_industries
    // requires exact LinkedIn taxonomy names — non-standard values cause 0 results.
    const validIndustries: string[] = [];
    const keywordTags = new Set<string>();

    if (params.industries?.length) {
      for (const ind of params.industries) {
        if (APOLLO_INDUSTRY_TAXONOMY.has(ind)) {
          validIndustries.push(ind);
        } else {
          // Try fuzzy match against taxonomy
          const matches = fuzzyMatchIndustry(ind);
          if (matches.length > 0) {
            validIndustries.push(...matches);
          } else {
            keywordTags.add(ind); // Non-standard — use as keyword tag
          }
        }
      }
    }
    if (params.keywords?.length) {
      for (const kw of params.keywords) keywordTags.add(kw);
    }

    if (validIndustries.length > 0) body.organization_industries = [...new Set(validIndustries)];
    if (keywordTags.size > 0) body.q_organization_keyword_tags = [...keywordTags];

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

/**
 * Official Apollo/LinkedIn industry taxonomy.
 * organization_industries MUST use exact values from this list — non-standard
 * values cause the entire search to return 0 results.
 */
const APOLLO_INDUSTRY_TAXONOMY = new Set([
  'Accounting', 'Airlines/Aviation', 'Alternative Dispute Resolution',
  'Alternative Medicine', 'Animation', 'Apparel & Fashion',
  'Architecture & Planning', 'Arts & Crafts', 'Automotive',
  'Aviation & Aerospace', 'Banking', 'Biotechnology', 'Broadcast Media',
  'Building Materials', 'Business Supplies & Equipment', 'Capital Markets',
  'Chemicals', 'Civic & Social Organization', 'Civil Engineering',
  'Commercial Real Estate', 'Computer & Network Security', 'Computer Games',
  'Computer Hardware', 'Computer Networking', 'Computer Software',
  'Construction', 'Consumer Electronics', 'Consumer Goods',
  'Consumer Services', 'Cosmetics', 'Dairy', 'Defense & Space', 'Design',
  'E-Learning', 'Education Management', 'Electrical/Electronic Manufacturing',
  'Entertainment', 'Environmental Services', 'Events Services',
  'Executive Office', 'Facilities Services', 'Farming', 'Financial Services',
  'Fine Art', 'Fishery', 'Food & Beverages', 'Food Production',
  'Fund-Raising', 'Furniture', 'Gambling & Casinos',
  'Glass, Ceramics & Concrete', 'Government Administration',
  'Government Relations', 'Graphic Design', 'Health, Wellness & Fitness',
  'Higher Education', 'Hospital & Health Care', 'Hospitality',
  'Human Resources', 'Import & Export', 'Individual & Family Services',
  'Industrial Automation', 'Information Services',
  'Information Technology & Services', 'Insurance', 'International Affairs',
  'International Trade & Development', 'Internet', 'Investment Banking',
  'Investment Management', 'Judiciary', 'Law Enforcement', 'Law Practice',
  'Legal Services', 'Legislative Office', 'Leisure, Travel & Tourism',
  'Libraries', 'Linguistics', 'Logistics & Supply Chain',
  'Luxury Goods & Jewelry', 'Machinery', 'Management Consulting',
  'Maritime', 'Market Research', 'Marketing & Advertising',
  'Mechanical or Industrial Engineering', 'Media Production',
  'Medical Devices', 'Medical Practice', 'Mental Health Care', 'Military',
  'Mining & Metals', 'Motion Pictures & Film', 'Museums & Institutions',
  'Music', 'Nanotechnology', 'Newspapers',
  'Non-Profit Organization Management', 'Oil & Energy', 'Online Media',
  'Outsourcing/Offshoring', 'Package/Freight Delivery',
  'Packaging & Containers', 'Paper & Forest Products', 'Performing Arts',
  'Pharmaceuticals', 'Philanthropy', 'Photography', 'Plastics',
  'Political Organization', 'Primary/Secondary Education', 'Printing',
  'Professional Training & Coaching', 'Program Development', 'Public Policy',
  'Public Relations & Communications', 'Public Safety', 'Publishing',
  'Railroad Manufacture', 'Ranching', 'Real Estate',
  'Recreational Facilities & Services', 'Religious Institutions',
  'Renewables & Environment', 'Research', 'Restaurants', 'Retail',
  'Security & Investigations', 'Semiconductors', 'Shipbuilding',
  'Sporting Goods', 'Sports', 'Staffing & Recruiting', 'Supermarkets',
  'Telecommunications', 'Textiles', 'Think Tanks', 'Tobacco',
  'Translation & Localization', 'Transportation/Trucking/Railroad',
  'Utilities', 'Venture Capital & Private Equity', 'Veterinary',
  'Warehousing', 'Wholesale', 'Wine & Spirits', 'Wireless',
  'Writing & Editing',
]);

/** Lowercase lookup for fuzzy matching ICP industry names to Apollo taxonomy */
const APOLLO_INDUSTRY_LOWER_MAP = new Map<string, string>();
for (const name of APOLLO_INDUSTRY_TAXONOMY) {
  APOLLO_INDUSTRY_LOWER_MAP.set(name.toLowerCase(), name);
}

/** Common aliases that map to Apollo taxonomy values */
const INDUSTRY_ALIASES: Record<string, string[]> = {
  'professional services': ['Management Consulting', 'Legal Services', 'Accounting', 'Financial Services'],
  'it services': ['Information Technology & Services'],
  'it consulting': ['Information Technology & Services'],
  'tech': ['Information Technology & Services', 'Computer Software'],
  'saas': ['Computer Software', 'Internet'],
  'recruitment': ['Staffing & Recruiting'],
  'hr': ['Human Resources'],
  'healthcare': ['Hospital & Health Care'],
  'education': ['Education Management', 'Higher Education'],
  'media': ['Online Media', 'Broadcast Media'],
  'pr': ['Public Relations & Communications'],
  'consulting': ['Management Consulting'],
  'finance': ['Financial Services'],
  'legal': ['Legal Services', 'Law Practice'],
  'advertising': ['Marketing & Advertising'],
  'marketing': ['Marketing & Advertising'],
  'real estate': ['Commercial Real Estate', 'Real Estate'],
  'logistics': ['Logistics & Supply Chain'],
  'manufacturing': ['Electrical/Electronic Manufacturing', 'Mechanical or Industrial Engineering'],
  'energy': ['Oil & Energy', 'Renewables & Environment'],
  'travel': ['Leisure, Travel & Tourism'],
  'food': ['Food & Beverages', 'Food Production'],
};

/**
 * Try to match a freeform industry name to the Apollo taxonomy.
 * Handles case differences, common aliases, and substring matching.
 * Returns an array since some aliases expand to multiple industries.
 */
function fuzzyMatchIndustry(input: string): string[] {
  const lower = input.toLowerCase().trim();

  // Exact (case-insensitive) match
  if (APOLLO_INDUSTRY_LOWER_MAP.has(lower)) return [APOLLO_INDUSTRY_LOWER_MAP.get(lower)!];

  // Check aliases
  if (INDUSTRY_ALIASES[lower]) return INDUSTRY_ALIASES[lower];

  // Substring match: input contains a taxonomy entry or vice versa
  const matches: string[] = [];
  for (const [key, value] of APOLLO_INDUSTRY_LOWER_MAP) {
    if (key.includes(lower) || lower.includes(key)) matches.push(value);
  }
  return matches;
}

