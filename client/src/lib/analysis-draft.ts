import type { AnalysisMode, AnalysisType } from "@/lib/analysis-types";

export interface AnalysisDraft {
  type: AnalysisType;
  analysisMode?: AnalysisMode;
  title: string;
  description: string;
  context: string;
}

const ANALYSIS_DRAFT_STORAGE_KEY = "nash-agent:new-analysis-draft";

function isAnalysisType(value: unknown): value is AnalysisType {
  return value === "feature" || value === "strategy";
}

function isAnalysisMode(value: unknown): value is AnalysisMode {
  return value === "nash" || value === "complexity" || value === "integrated";
}

export function saveAnalysisDraft(draft: AnalysisDraft) {
  if (typeof window === "undefined") return;

  window.sessionStorage.setItem(ANALYSIS_DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

export function consumeAnalysisDraft(): AnalysisDraft | null {
  if (typeof window === "undefined") return null;

  const raw = window.sessionStorage.getItem(ANALYSIS_DRAFT_STORAGE_KEY);
  if (!raw) return null;

  window.sessionStorage.removeItem(ANALYSIS_DRAFT_STORAGE_KEY);

  try {
    const parsed = JSON.parse(raw) as Partial<AnalysisDraft>;

    if (
      !isAnalysisType(parsed.type) ||
      typeof parsed.title !== "string" ||
      typeof parsed.description !== "string" ||
      typeof parsed.context !== "string"
    ) {
      return null;
    }

    return {
      type: parsed.type,
      analysisMode: isAnalysisMode(parsed.analysisMode) ? parsed.analysisMode : "nash",
      title: parsed.title,
      description: parsed.description,
      context: parsed.context,
    };
  } catch {
    return null;
  }
}
