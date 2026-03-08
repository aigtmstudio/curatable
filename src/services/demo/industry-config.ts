import type { signalCategoryEnum } from '../../db/schema/enums.js';

type SignalCategory = (typeof signalCategoryEnum.enumValues)[number];

export interface IndustryHypothesisSeed {
  hypothesis: string;
  signalCategory: SignalCategory;
  signalLevel: 'market' | 'company';
  priority: number;
  monitoringSources: string[];
  affectedSegments: string[];
}

export interface DemoIndustryConfig {
  label: string;
  segments: string[];
  relatedSectors: string[];
  hypotheses: IndustryHypothesisSeed[];
}

export const DEMO_INDUSTRIES: Record<string, DemoIndustryConfig> = {
  'financial-services': {
    label: 'Financial Services',
    segments: ['Banking', 'Insurance', 'Asset Management', 'FinTech', 'Payments', 'Wealth Management', 'Retail Banking'],
    relatedSectors: ['professional-services', 'technology'],
    hypotheses: [
      {
        hypothesis: 'Consumer Duty and open banking regulations are forcing banks and financial institutions to modernise compliance infrastructure and reporting capabilities',
        signalCategory: 'regulatory',
        signalLevel: 'market',
        priority: 1,
        monitoringSources: ['FCA', 'PRA', 'Bank of England', 'Reuters', 'Financial Times'],
        affectedSegments: ['Banking', 'Wealth Management', 'Retail Banking', 'Insurance'],
      },
      {
        hypothesis: 'Challenger banks and fintechs are expanding into business banking and lending, putting competitive pressure on traditional mid-tier banks',
        signalCategory: 'competitive',
        signalLevel: 'market',
        priority: 2,
        monitoringSources: ['TechCrunch', 'Sifted', 'AltFi', 'Finextra'],
        affectedSegments: ['FinTech', 'Banking', 'Payments'],
      },
      {
        hypothesis: 'Significant leadership changes at financial institutions signal strategic pivots and vendor review cycles within 90 days of appointment',
        signalCategory: 'leadership',
        signalLevel: 'company',
        priority: 3,
        monitoringSources: ['LinkedIn', 'Financial Times', 'City AM', 'company press releases'],
        affectedSegments: ['Banking', 'Asset Management', 'Insurance'],
      },
      {
        hypothesis: 'Late-stage funding rounds in compliance fintech and regtech indicate growing market demand for automation of regulatory workflows',
        signalCategory: 'funding',
        signalLevel: 'market',
        priority: 4,
        monitoringSources: ['Crunchbase', 'PitchBook', 'Sifted', 'TechCrunch'],
        affectedSegments: ['FinTech', 'Banking', 'Insurance'],
      },
    ],
  },
  'healthcare': {
    label: 'Healthcare',
    segments: ['NHS Trusts', 'Digital Health', 'Pharmaceuticals', 'MedTech', 'Private Healthcare', 'Health Insurance'],
    relatedSectors: ['technology', 'professional-services'],
    hypotheses: [
      {
        hypothesis: 'NHS digital transformation mandates and Federated Data Platform rollout are creating procurement opportunities for health tech vendors',
        signalCategory: 'regulatory',
        signalLevel: 'market',
        priority: 1,
        monitoringSources: ['NHS England', 'DHSC', 'HSJ', 'Digital Health'],
        affectedSegments: ['NHS Trusts', 'Digital Health', 'MedTech'],
      },
      {
        hypothesis: 'AI diagnostic tools and remote monitoring platforms are gaining regulatory approval, shifting competitive dynamics in clinical workflows',
        signalCategory: 'competitive',
        signalLevel: 'market',
        priority: 2,
        monitoringSources: ['MHRA', 'BMJ', 'The Lancet Digital Health', 'MobiHealthNews'],
        affectedSegments: ['Digital Health', 'MedTech', 'Pharmaceuticals'],
      },
      {
        hypothesis: 'New CTO, CDO and CCIO appointments at NHS trusts and health systems trigger technology strategy reviews and vendor assessments',
        signalCategory: 'leadership',
        signalLevel: 'company',
        priority: 3,
        monitoringSources: ['HSJ', 'Digital Health', 'LinkedIn', 'NHS Jobs'],
        affectedSegments: ['NHS Trusts', 'Private Healthcare'],
      },
      {
        hypothesis: 'Venture capital investment in health tech and digital therapeutics is accelerating, particularly in remote patient monitoring and mental health platforms',
        signalCategory: 'funding',
        signalLevel: 'market',
        priority: 4,
        monitoringSources: ['Crunchbase', 'Rock Health', 'Sifted', 'PitchBook'],
        affectedSegments: ['Digital Health', 'MedTech', 'Health Insurance'],
      },
    ],
  },
  'technology': {
    label: 'Technology',
    segments: ['SaaS', 'Cybersecurity', 'Cloud Infrastructure', 'AI & Machine Learning', 'Enterprise Software', 'DevTools'],
    relatedSectors: ['financial-services', 'professional-services'],
    hypotheses: [
      {
        hypothesis: 'AI regulation (EU AI Act, UK AI Safety Institute) is creating compliance requirements that push enterprise software companies to audit and certify their AI systems',
        signalCategory: 'regulatory',
        signalLevel: 'market',
        priority: 1,
        monitoringSources: ['EU Commission', 'UK DSIT', 'TechCrunch', 'The Register'],
        affectedSegments: ['AI & Machine Learning', 'Enterprise Software', 'SaaS'],
      },
      {
        hypothesis: 'Platform consolidation and AI-native competitors are disrupting established SaaS categories, forcing incumbents to acquire or partner',
        signalCategory: 'competitive',
        signalLevel: 'market',
        priority: 2,
        monitoringSources: ['TechCrunch', 'The Information', 'Stratechery', 'Hacker News'],
        affectedSegments: ['SaaS', 'Enterprise Software', 'DevTools'],
      },
      {
        hypothesis: 'CISO and CTO appointments at mid-market tech companies signal security posture reviews and infrastructure modernisation within the first quarter',
        signalCategory: 'leadership',
        signalLevel: 'company',
        priority: 3,
        monitoringSources: ['LinkedIn', 'company blogs', 'SecurityWeek', 'VentureBeat'],
        affectedSegments: ['Cybersecurity', 'Cloud Infrastructure', 'SaaS'],
      },
      {
        hypothesis: 'Growth-stage funding rounds in AI infrastructure and cybersecurity indicate where enterprise buyers expect to increase spend in the next 12 months',
        signalCategory: 'funding',
        signalLevel: 'market',
        priority: 4,
        monitoringSources: ['Crunchbase', 'PitchBook', 'TechCrunch', 'Sifted'],
        affectedSegments: ['AI & Machine Learning', 'Cybersecurity', 'Cloud Infrastructure'],
      },
    ],
  },
  'professional-services': {
    label: 'Professional Services',
    segments: ['Management Consulting', 'Legal', 'Accounting', 'Recruitment', 'Advisory', 'Outsourcing'],
    relatedSectors: ['financial-services', 'technology'],
    hypotheses: [
      {
        hypothesis: 'SRA and FCA regulatory changes are driving law firms and advisory practices to invest in compliance technology and client due diligence platforms',
        signalCategory: 'regulatory',
        signalLevel: 'market',
        priority: 1,
        monitoringSources: ['SRA', 'Law Society Gazette', 'Legal Futures', 'The Lawyer'],
        affectedSegments: ['Legal', 'Accounting', 'Advisory'],
      },
      {
        hypothesis: 'AI-powered automation is reshaping competitive dynamics in professional services as firms race to embed AI into client delivery and back-office operations',
        signalCategory: 'competitive',
        signalLevel: 'market',
        priority: 2,
        monitoringSources: ['Consultancy.uk', 'The Lawyer', 'Financial Times', 'McKinsey Insights'],
        affectedSegments: ['Management Consulting', 'Legal', 'Accounting'],
      },
      {
        hypothesis: 'Managing partner and CEO transitions at top-50 professional services firms trigger strategic reviews of technology stack and vendor relationships',
        signalCategory: 'leadership',
        signalLevel: 'company',
        priority: 3,
        monitoringSources: ['The Lawyer', 'Consultancy.uk', 'LinkedIn', 'Legal 500'],
        affectedSegments: ['Management Consulting', 'Legal', 'Recruitment'],
      },
      {
        hypothesis: 'Private equity investment in professional services roll-ups is accelerating, creating post-merger integration opportunities for technology vendors',
        signalCategory: 'funding',
        signalLevel: 'market',
        priority: 4,
        monitoringSources: ['PitchBook', 'Mergermarket', 'Consultancy.uk', 'PE Hub'],
        affectedSegments: ['Legal', 'Accounting', 'Advisory', 'Outsourcing'],
      },
    ],
  },
  'construction-property': {
    label: 'Construction & Property',
    segments: ['Housebuilding', 'Commercial Construction', 'Property Management', 'Real Estate', 'Infrastructure', 'Facilities Management'],
    relatedSectors: ['technology', 'financial-services'],
    hypotheses: [
      {
        hypothesis: 'Building Safety Act, Future Homes Standard, and sustainability reporting requirements are creating urgent demand for construction compliance and BIM technology',
        signalCategory: 'regulatory',
        signalLevel: 'market',
        priority: 1,
        monitoringSources: ['DLUHC', 'Construction News', 'Building Magazine', 'RICS'],
        affectedSegments: ['Housebuilding', 'Commercial Construction', 'Property Management'],
      },
      {
        hypothesis: 'Modular construction and proptech platforms are disrupting traditional builders and property managers, forcing digital transformation of project management',
        signalCategory: 'competitive',
        signalLevel: 'market',
        priority: 2,
        monitoringSources: ['Construction News', 'Property Week', 'Estates Gazette', 'PlaceTech'],
        affectedSegments: ['Housebuilding', 'Commercial Construction', 'Real Estate'],
      },
      {
        hypothesis: 'New MD and CTO appointments at tier-1 contractors and property groups signal technology strategy resets and vendor consolidation',
        signalCategory: 'leadership',
        signalLevel: 'company',
        priority: 3,
        monitoringSources: ['Construction News', 'Building Magazine', 'LinkedIn', 'company announcements'],
        affectedSegments: ['Commercial Construction', 'Infrastructure', 'Property Management'],
      },
      {
        hypothesis: 'PropTech and construction tech funding activity indicates where the industry expects digital adoption to accelerate in the next 18 months',
        signalCategory: 'funding',
        signalLevel: 'market',
        priority: 4,
        monitoringSources: ['Crunchbase', 'PropTech Association', 'Sifted', 'TechCrunch'],
        affectedSegments: ['Real Estate', 'Housebuilding', 'Facilities Management'],
      },
    ],
  },
};

export type DemoIndustrySlug = keyof typeof DEMO_INDUSTRIES;

const SLUG_ALIASES: Record<string, DemoIndustrySlug> = {
  'financial services': 'financial-services',
  'finance': 'financial-services',
  'banking': 'financial-services',
  'fintech': 'financial-services',
  'healthcare': 'healthcare',
  'health': 'healthcare',
  'medical': 'healthcare',
  'pharma': 'healthcare',
  'technology': 'technology',
  'tech': 'technology',
  'software': 'technology',
  'saas': 'technology',
  'it': 'technology',
  'professional services': 'professional-services',
  'consulting': 'professional-services',
  'legal': 'professional-services',
  'accounting': 'professional-services',
  'construction & property': 'construction-property',
  'construction': 'construction-property',
  'property': 'construction-property',
  'real estate': 'construction-property',
  'construction and property': 'construction-property',
};

/**
 * Normalize an industry input string to a demo industry slug.
 * Supports exact labels, aliases, and case-insensitive matching.
 */
export function normalizeIndustryInput(input: string): DemoIndustrySlug | null {
  const normalised = input.toLowerCase().trim();

  // Direct slug match
  if (normalised in DEMO_INDUSTRIES) return normalised as DemoIndustrySlug;

  // Alias match
  if (normalised in SLUG_ALIASES) return SLUG_ALIASES[normalised];

  // Reverse label match (e.g. "Financial Services" → "financial-services")
  for (const [slug, config] of Object.entries(DEMO_INDUSTRIES)) {
    if (config.label.toLowerCase() === normalised) return slug as DemoIndustrySlug;
  }

  return null;
}

const CATEGORY_TO_SIGNAL_TYPE: Record<string, string> = {
  regulatory: 'regulatory_change',
  competitive: 'competitive_move',
  leadership: 'leadership_change',
  funding: 'funding_round',
};

export function mapCategoryToSignalType(category: string | null): string {
  return CATEGORY_TO_SIGNAL_TYPE[category ?? ''] ?? category ?? 'unknown';
}
