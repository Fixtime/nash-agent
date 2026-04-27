import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { z } from "zod";

// ─── Analysis sessions ───────────────────────────────────────────────────────
export const analyses = sqliteTable("analyses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  type: text("type").notNull(),          // "strategy" | "feature"
  description: text("description").notNull(),
  players: text("players").notNull(),    // JSON: Player[]
  context: text("context").notNull(),    // additional context
  status: text("status").notNull().default("pending"), // pending | running | done | error | cancelled
  result: text("result"),                // JSON: AnalysisResult
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

function deriveTitleFromDescription(description: string): string {
  const clean = description.replace(/\s+/g, " ").trim();
  if (!clean) return "Nash analysis case";
  return clean.slice(0, 80);
}

function normalizePlayersInput(value: string | unknown[] | undefined): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }

  if (typeof value !== "string") {
    return "[]";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "[]";
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? JSON.stringify(parsed) : "[]";
  } catch {
    return "[]";
  }
}

export const insertAnalysisSchema = z
  .object({
    type: z.enum(["strategy", "feature"]).optional().default("feature"),
    title: z.string().trim().optional(),
    description: z
      .string()
      .trim()
      .min(12, "Добавьте более содержательное описание кейса"),
    players: z.union([z.string(), z.array(z.unknown())]).optional(),
    context: z.string().optional().default(""),
  })
  .transform((value) => ({
    type: value.type,
    title: value.title?.trim() || deriveTitleFromDescription(value.description),
    description: value.description.trim(),
    players: normalizePlayersInput(value.players),
    context: value.context?.trim() || "",
  }));

export type InsertAnalysis = z.infer<typeof insertAnalysisSchema>;
export type Analysis = typeof analyses.$inferSelect;

// ─── Runtime types (not stored) ──────────────────────────────────────────────
export type PlayerType =
  | "competitor"
  | "partner"
  | "regulator"
  | "user"
  | "platform"
  | "other";

export type PlayerTier = "core" | "secondary" | "aggregated";
export type PlayerSource = "user" | "inferred" | "merged";

export interface Player {
  id: string;
  name: string;
  type: PlayerType;
  strategies: string[];
  incentives: string;
  tier?: PlayerTier;
  weight?: number; // 1..5 strategic importance
  source?: PlayerSource;
}

export interface StrategyProfile {
  id: string;
  selections: Record<string, string>; // playerId -> strategy
  payoffs: Record<string, number>;    // playerId -> payoff score -10..10
  feasible: boolean;
  summary: string;
}

export interface DeviationCheck {
  playerId: string;
  fromStrategy: string;
  toStrategy: string;
  payoffDelta: number;
  profitable: boolean;
}

export interface NashScenario {
  profileId?: string;
  strategies: Record<string, string>; // playerId -> strategy
  payoffs: Record<string, number>;    // playerId -> payoff score -10..10
  isNash: boolean;
  stability: "stable" | "unstable" | "conditional";
  description: string;
  deviations?: DeviationCheck[];
}

export interface PayoffCell {
  strategies: Record<string, string>;
  payoffs: Record<string, number>;
  isNash: boolean;
}

export interface PairwiseView {
  players: [string, string];
  matrix: PayoffCell[][];
  matrixStrategies: Record<string, string[]>;
}

export interface SensitivityCheck {
  omittedPlayerId: string;
  impact: "low" | "medium" | "high";
  note: string;
}

export type ProductDecision = "launch" | "revise" | "pause" | "kill";

export interface StrategicMove {
  title: string;
  objective: string;
  targetPlayerId: string;
  changesIncentiveHow: string;
  expectedNashScoreDelta: number;
  expectedPayoffDelta: Record<string, number>;
  effort: "S" | "M" | "L";
  confidence: number;
  priority: number;
}

export interface ExperimentPlanItem {
  hypothesis: string;
  metric: string;
  guardrailMetric: string;
  successCriterion: string;
  killCriterion: string;
  timebox: string;
}

export interface CounterMovePlaybookItem {
  threat: string;
  earlySignal: string;
  mitigation: string;
}

export interface DecisionPack {
  executiveSummary: string;
  recommendedDecision: ProductDecision;
  whyNow: string;
  targetEquilibrium: string | null;
  topStrategicMoves: StrategicMove[];
  experimentPlan: ExperimentPlanItem[];
  launchGuardrails: string[];
  counterMovePlaybook: CounterMovePlaybookItem[];
  openQuestions: string[];
}

export interface AnalysisRuntimeStats {
  durationMs: number;
  chunks: number;
}

export interface AnalysisResult {
  // New canonical n-player structure
  playersUsed: Player[];
  aggregatedActors: string[];
  assumptions: string[];
  profiles: StrategyProfile[];
  confidence: number; // 0-100: how robust the model of players/payoffs is
  pairwiseViews: PairwiseView[];
  sensitivityChecks: SensitivityCheck[];

  // Backward-compatible fields used by the existing UI
  equilibria: NashScenario[];
  recommendedEquilibrium: NashScenario | null;
  nashScore: number;         // 0-100: readiness for launch
  riskLevel: "low" | "medium" | "high" | "critical";
  verdict: "launch" | "revise" | "pause" | "kill";
  keyInsights: string[];
  breakEquilibriumMoves: string[];
  recommendations: string[];
  decisionPack?: DecisionPack;
  runtimeStats?: AnalysisRuntimeStats;
  gameType: string;
  payoffMatrix: PayoffCell[][];
  matrixPlayers: string[];
  matrixStrategies: Record<string, string[]>;
  rawThinking: string;
}
