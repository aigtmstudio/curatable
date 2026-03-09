export interface ApolloOrganization {
  id: string;
  name: string;
  website_url?: string;
  primary_domain?: string;
  linkedin_url?: string;
  logo_url?: string;
  industry?: string;
  sub_industry?: string;
  estimated_num_employees?: number;
  employee_range?: string;
  annual_revenue?: number;
  annual_revenue_printed?: string;
  founded_year?: number;
  total_funding?: number;
  total_funding_printed?: string;
  latest_funding_stage?: string;
  latest_funding_round_date?: string;
  city?: string;
  state?: string;
  country?: string;
  street_address?: string;
  short_description?: string;
  phone?: string;
  technology_names?: string[];
  keywords?: string[];
}

export interface ApolloPerson {
  id: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  linkedin_url?: string;
  photo_url?: string;
  title?: string;
  seniority?: string;
  departments?: string[];
  city?: string;
  state?: string;
  country?: string;
  email?: string;
  email_status?: string;
  organization_id?: string;
  organization?: {
    id: string;
    name?: string;
    primary_domain?: string;
  };
  phone_numbers?: Array<{
    raw_number: string;
    type: string;
  }>;
  employment_history?: Array<{
    organization_name?: string;
    title?: string;
    start_date?: string;
    end_date?: string;
    current: boolean;
  }>;
}

export interface ApolloOrgEnrichResponse {
  organization: ApolloOrganization;
  credits_consumed?: number;
}

export interface ApolloPeopleSearchResponse {
  people: ApolloPerson[];
  pagination: {
    page: number;
    per_page: number;
    total_entries: number;
    total_pages: number;
  };
}

export interface ApolloCompanySearchResponse {
  organizations: ApolloOrganization[];
  pagination: {
    page: number;
    per_page: number;
    total_entries: number;
    total_pages: number;
  };
}

export interface ApolloPersonEnrichResponse {
  person: ApolloPerson;
  credits_consumed?: number;
}

export interface ApolloApiSearchResponse {
  total_entries: number;
  people: Array<{
    id: string;
    first_name?: string;
    last_name_obfuscated?: string;
    title?: string;
    organization?: {
      name?: string;
    };
  }>;
}

export interface ApolloBulkMatchResponse {
  status: string;
  matches: ApolloPerson[];
  credits_consumed: number;
}
