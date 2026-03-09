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
      const maxPages = Math.min(Math.ceil(targetLimit / 100), 25);

      // Phase 1: Industry search (taxonomy-validated industries + location + headcount)
      const industryBody = this.buildIndustryBody(params);
      this.log.info({ searchBody: industryBody, targetLimit, maxPages, phase: 'industry' }, 'Apollo industry search starting');
      const industryResult = await this.paginateSearch(industryBody, targetLimit, maxPages);

      this.log.info(
        { phase: 'industry', totalEntries: industryResult.totalEntries, fetched: industryResult.companies.length },
        'Apollo industry search complete',
      );

      // Phase 2: Keyword search (keyword tags + location + headcount, NO industries)
      // q_organization_keyword_tags uses OR — invalid tags are silently ignored
      const keywordTags = simplifyKeywords([...(params.industries ?? []), ...(params.keywords ?? [])]);
      let keywordResult = { companies: [] as UnifiedCompany[], totalEntries: 0 };

      if (keywordTags.length > 0) {
        const keywordBody = this.buildKeywordBody(params, keywordTags);
        this.log.info({ searchBody: keywordBody, phase: 'keyword' }, 'Apollo keyword search starting');
        keywordResult = await this.paginateSearch(keywordBody, targetLimit, maxPages);

        this.log.info(
          { phase: 'keyword', totalEntries: keywordResult.totalEntries, fetched: keywordResult.companies.length },
          'Apollo keyword search complete',
        );
      }

      // Merge: keyword results first (more relevant), then industry-only, dedup by domain
      const merged: UnifiedCompany[] = [];
      const seenDomains = new Set<string>();
      for (const company of [...keywordResult.companies, ...industryResult.companies]) {
        const d = company.domain?.toLowerCase();
        if (d && seenDomains.has(d)) continue;
        if (d) seenDomains.add(d);
        merged.push(company);
        if (merged.length >= targetLimit) break;
      }

      const totalEntries = Math.max(industryResult.totalEntries, keywordResult.totalEntries);

      return {
        success: true,
        data: merged,
        totalResults: totalEntries,
        hasMore: merged.length < totalEntries,
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

  /** Paginate through Apollo search results, deduplicating by domain */
  private async paginateSearch(
    body: Record<string, unknown>,
    targetLimit: number,
    maxPages: number,
  ): Promise<{ companies: UnifiedCompany[]; totalEntries: number }> {
    const companies: UnifiedCompany[] = [];
    const seenDomains = new Set<string>();
    let totalEntries = 0;

    for (let i = 0; i < maxPages; i++) {
      const pageNum = i + 1;
      const raw = await this.request<ApolloCompanySearchResponse>(
        'post', '/mixed_companies/search', { body: { ...body, page: pageNum, per_page: 100 } },
      );

      totalEntries = raw.pagination.total_entries;
      if (!raw.organizations?.length) break;

      for (const org of raw.organizations) {
        const company = mapApolloOrganization(org);
        const domain = company.domain?.toLowerCase();
        if (domain && seenDomains.has(domain)) continue;
        if (domain) seenDomains.add(domain);
        companies.push(company);
      }

      this.log.info(
        { page: pageNum, totalPages: raw.pagination.total_pages, totalEntries, accumulated: companies.length },
        'Apollo search page fetched',
      );

      if (companies.length >= targetLimit) break;
      if (pageNum >= raw.pagination.total_pages) break;
    }

    return { companies, totalEntries };
  }

  /** Build search body with taxonomy-validated industries (no keywords) */
  private buildIndustryBody(params: CompanySearchParams): Record<string, unknown> {
    const body = this.buildBaseBody(params);

    const validIndustries: string[] = [];
    if (params.industries?.length) {
      for (const ind of params.industries) {
        if (APOLLO_INDUSTRY_TAXONOMY.has(ind)) {
          validIndustries.push(ind);
        } else {
          validIndustries.push(...fuzzyMatchIndustry(ind));
        }
      }
    }
    if (validIndustries.length > 0) body.organization_industries = [...new Set(validIndustries)];

    return body;
  }

  /** Build search body with keyword tags only (no industries — avoids AND problem) */
  private buildKeywordBody(params: CompanySearchParams, tags: string[]): Record<string, unknown> {
    const body = this.buildBaseBody(params);
    body.q_organization_keyword_tags = tags;
    return body;
  }

  /** Shared base: location + headcount + excludes */
  private buildBaseBody(params: CompanySearchParams): Record<string, unknown> {
    const body: Record<string, unknown> = {};

    if (params.employeeCountMin != null || params.employeeCountMax != null) {
      body.organization_num_employees_ranges = buildEmployeeRanges(
        params.employeeCountMin, params.employeeCountMax,
      );
    }

    const locations: string[] = [];
    if (params.countries?.length) locations.push(...params.countries.map(expandCountryCode));
    if (params.states?.length) locations.push(...params.states);
    if (params.cities?.length) locations.push(...params.cities);
    if (locations.length) body.organization_locations = locations;

    if (params.excludeKeywords?.length) {
      body.q_not_keywords = params.excludeKeywords.join(' ');
    }

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

function simplifyKeywords(raw: string[]): string[] {
  const tags = new Set<string>();
  for (const kw of raw) {
    const lower = kw.toLowerCase().trim();
    if (!lower) continue;
    tags.add(lower);
    // Split compound terms on " & " or " and "
    if (lower.includes(' & ') || lower.includes(' and ')) {
      for (const part of lower.split(/\s*[&]\s*|\s+and\s+/)) {
        const trimmed = part.trim();
        if (trimmed.length > 2) tags.add(trimmed);
      }
    }
  }
  return [...tags];
}

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

