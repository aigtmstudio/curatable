// ============================================================
// Unified data types — all providers normalize to these
// ============================================================

export interface UnifiedCompany {
  name: string;
  domain?: string;
  linkedinUrl?: string;
  websiteUrl?: string;
  industry?: string;
  subIndustry?: string;
  employeeCount?: number;
  employeeRange?: string;
  annualRevenue?: number;
  revenueRange?: string;
  foundedYear?: number;
  totalFunding?: number;
  latestFundingStage?: string;
  latestFundingDate?: string;
  city?: string;
  state?: string;
  country?: string;
  address?: string;
  techStack?: string[];
  logoUrl?: string;
  description?: string;
  websiteProfile?: string;
  phone?: string;
  externalIds: Record<string, string>;
}

export interface UnifiedContact {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  linkedinUrl?: string;
  photoUrl?: string;
  title?: string;
  seniority?: string;
  department?: string;
  companyName?: string;
  companyDomain?: string;
  workEmail?: string;
  personalEmail?: string;
  phone?: string;
  mobilePhone?: string;
  city?: string;
  state?: string;
  country?: string;
  employmentHistory?: Array<{
    company: string;
    title: string;
    startDate?: string;
    endDate?: string;
    isCurrent: boolean;
  }>;
  externalIds: Record<string, string>;
}

export interface EmailVerificationResult {
  email: string;
  status: 'valid' | 'invalid' | 'catch_all' | 'unknown';
  provider: string;
  confidence?: number;
  verifiedAt: string;
}

// ============================================================
// Provider capability types
// ============================================================

export type ProviderCapability =
  | 'company_search'
  | 'company_enrich'
  | 'people_search'
  | 'people_enrich'
  | 'email_find'
  | 'email_verify';

export interface CompanySearchParams {
  query?: string; // Semantic search query — used directly by providers like Exa
  industries?: string[];
  employeeCountMin?: number;
  employeeCountMax?: number;
  revenueMin?: number;
  revenueMax?: number;
  fundingStages?: string[];
  techStack?: string[];
  countries?: string[];
  states?: string[];
  cities?: string[];
  keywords?: string[];
  excludeKeywords?: string[];
  excludeIndustries?: string[];
  limit?: number;
  offset?: number;
}

export interface CompanyEnrichParams {
  domain?: string;
  name?: string;
}

export interface PeopleSearchParams {
  titlePatterns?: string[];
  seniorityLevels?: string[];
  departments?: string[];
  companyDomains?: string[];
  companyNames?: string[];
  countries?: string[];
  limit?: number;
  offset?: number;
}

export interface PeopleEnrichParams {
  firstName?: string;
  lastName?: string;
  email?: string;
  linkedinUrl?: string;
  companyDomain?: string;
}

export interface EmailFindParams {
  firstName: string;
  lastName: string;
  companyDomain: string;
}

export interface EmailVerifyParams {
  email: string;
}

// ============================================================
// Provider response wrappers
// ============================================================

export interface ProviderResponse<T> {
  success: boolean;
  data: T | null;
  error?: string;
  rateLimitRemaining?: number;
  creditsConsumed: number;
  fieldsPopulated: string[];
  qualityScore: number;
}

export interface PaginatedResponse<T> extends ProviderResponse<T[]> {
  totalResults: number;
  hasMore: boolean;
  nextPageToken?: string | number;
}

// ============================================================
// Provider interface — what every adapter must implement
// ============================================================

export interface DataProvider {
  readonly name: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapability[];

  searchCompanies?(params: CompanySearchParams): Promise<PaginatedResponse<UnifiedCompany>>;
  enrichCompany?(params: CompanyEnrichParams): Promise<ProviderResponse<UnifiedCompany>>;

  searchPeople?(params: PeopleSearchParams): Promise<PaginatedResponse<UnifiedContact>>;
  enrichPerson?(params: PeopleEnrichParams): Promise<ProviderResponse<UnifiedContact>>;

  findEmail?(params: EmailFindParams): Promise<ProviderResponse<{ email: string; confidence: number }>>;
  verifyEmail?(params: EmailVerifyParams): Promise<ProviderResponse<EmailVerificationResult>>;

  healthCheck(): Promise<boolean>;
}
