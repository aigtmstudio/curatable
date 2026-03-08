import type { BuzzReport } from '../../db/schema/market-buzz.js';

/**
 * Demo buzz report shape — matches the Curatable website frontend contract.
 */
export interface DemoBuzzReport {
  id: string;
  title: string;
  generatedAt: string;
  executiveSummary: string;
  keyThemes: string[];
  signalBreakdown: {
    regulatory: { count: number; highlights: string[] };
    leadership: { count: number; highlights: string[] };
    competitive: { count: number; highlights: string[] };
    funding: { count: number; highlights: string[] };
  };
  recommendedActions: string[];
  timeWindowDays: number;
}

const DEMO_CATEGORIES = ['regulatory', 'leadership', 'competitive', 'funding'] as const;

/**
 * Transform the internal BuzzReport format into the demo response shape.
 * Pure transformation — no LLM calls. Produces a useful report from existing data.
 */
export function transformBuzzReport(
  report: BuzzReport,
  reportId: string,
  industryLabel: string,
): DemoBuzzReport {
  // Key themes: top trending topic names
  const keyThemes = report.trendingTopics.slice(0, 5).map(t => t.topic);

  // Signal breakdown: aggregate signals from topics by category
  const categoryData: Record<string, { count: number; headlines: string[] }> = {};
  for (const cat of DEMO_CATEGORIES) {
    categoryData[cat] = { count: 0, headlines: [] };
  }

  for (const topic of report.trendingTopics) {
    const cat = topic.category.toLowerCase();
    if (cat in categoryData) {
      categoryData[cat].count += topic.signalCount;
      categoryData[cat].headlines.push(topic.topic);
      // Also include supporting signal headlines for richer highlights
      for (const sig of (topic.supportingSignals ?? []).slice(0, 2)) {
        if (sig.headline && !categoryData[cat].headlines.includes(sig.headline)) {
          categoryData[cat].headlines.push(sig.headline);
        }
      }
    }
  }

  const signalBreakdown = {
    regulatory: { count: categoryData.regulatory.count, highlights: categoryData.regulatory.headlines.slice(0, 3) },
    leadership: { count: categoryData.leadership.count, highlights: categoryData.leadership.headlines.slice(0, 3) },
    competitive: { count: categoryData.competitive.count, highlights: categoryData.competitive.headlines.slice(0, 3) },
    funding: { count: categoryData.funding.count, highlights: categoryData.funding.headlines.slice(0, 3) },
  };

  // Recommended actions: derive from webinar angles (reframed as actionable recommendations)
  const recommendedActions = report.webinarAngles.slice(0, 5).map(angle => {
    // Combine the client angle with the target segment for actionable advice
    const segments = angle.targetSegments.slice(0, 2).join(' and ');
    return `${angle.clientAngle} Target ${segments} teams for highest engagement.`;
  });

  // Executive summary: synthesize from topics + signal data
  const totalSignals = report.inputSummary.signalsAnalyzed;
  const topicSummaries = report.trendingTopics.slice(0, 3).map(t => t.description.split('.')[0]).join('. ');

  const topCategories = Object.entries(signalBreakdown)
    .filter(([, v]) => v.count > 0)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 2)
    .map(([k]) => k);

  const executiveSummary = [
    `## ${industryLabel} Market Intelligence — ${report.timeWindow.days}-Day Window\n`,
    `Analysis of **${totalSignals} market signals** across the ${industryLabel} sector reveals ${report.trendingTopics.length} significant trending themes demanding attention.\n`,
    `### Dominant Themes\n`,
    `${topicSummaries}.\n`,
    topCategories.length > 0 ?
      `### Signal Density\n\nThe highest signal concentration is in **${topCategories.join('** and **')}** categories, suggesting these are the primary areas of market movement. ${signalBreakdown.regulatory.count > 0 ? `Regulatory signals (${signalBreakdown.regulatory.count}) indicate compliance-driven buying pressure.` : ''} ${signalBreakdown.funding.count > 0 ? `Funding activity (${signalBreakdown.funding.count} signals) points to growing investment appetite in the sector.` : ''}\n` : '',
    `### Strategic Window\n`,
    `The convergence of ${keyThemes.slice(0, 2).join(' and ')} creates a time-bounded opportunity for vendors positioned at the intersection of these trends. Early movers with relevant solutions have a 60-90 day window before market awareness peaks.`,
  ].join('');

  return {
    id: reportId,
    title: `${industryLabel} Market Intelligence Briefing`,
    generatedAt: report.generatedAt,
    executiveSummary,
    keyThemes,
    signalBreakdown,
    recommendedActions,
    timeWindowDays: report.timeWindow.days,
  };
}
