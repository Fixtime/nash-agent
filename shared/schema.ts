import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { z } from "zod";

// ─── Analysis sessions ───────────────────────────────────────────────────────
export const analyses = sqliteTable("analyses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  type: text("type").notNull(),          // "strategy" | "feature"
  analysisMode: text("analysis_mode").notNull().default("nash"), // "nash" | "complexity" | "integrated"
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
    analysisMode: z.enum(["nash", "complexity", "integrated"]).optional().default("nash"),
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
    analysisMode: value.analysisMode,
    title: value.title?.trim() || deriveTitleFromDescription(value.description),
    description: value.description.trim(),
    players: normalizePlayersInput(value.players),
    context: value.context?.trim() || "",
  }));

export type InsertAnalysis = z.infer<typeof insertAnalysisSchema>;
export type Analysis = typeof analyses.$inferSelect;
export type AnalysisMode = "nash" | "complexity" | "integrated";

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
  analysisMode?: "nash";
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

export type ComplexityAgentType =
  | "team"
  | "user"
  | "competitor"
  | "partner"
  | "platform"
  | "regulator"
  | "other";

export type ComplexityScenarioId = "baseline" | "upside" | "stress";
export type ComplexityRegimeKind =
  | "growth"
  | "stall"
  | "lock_in"
  | "cascade"
  | "overload"
  | "commoditization"
  | "recovery";

export interface ComplexityCondition {
  variableId: string;
  op: "lt" | "lte" | "gt" | "gte" | "between";
  value: number | [number, number];
}

export interface ComplexityAdaptationRule {
  id: string;
  label: string;
  priority: number;
  when: ComplexityCondition[];
  move: string;
  impacts: Record<string, number>;
  rationale: string;
}

export interface ComplexityAgent {
  id: string;
  name: string;
  type: ComplexityAgentType;
  weight: number;
  goals: string[];
  likelyMoves: string[];
  adaptationRules: ComplexityAdaptationRule[];
}

export interface ComplexityStateVariable {
  id: string;
  name: string;
  description: string;
  initialValue: number;
  targetDirection: "up" | "down" | "range";
  targetMin?: number;
  targetMax?: number;
}

export interface ComplexityFeedbackLoop {
  id: string;
  type: "reinforcing" | "balancing";
  label: string;
  description: string;
  impacts?: Record<string, number>;
}

export interface ComplexityTippingPoint {
  id: string;
  label: string;
  variableId: string;
  threshold: number;
  direction: "up" | "down";
  consequence: string;
}

export interface ComplexityPathDependency {
  id: string;
  earlyCondition: string;
  laterEffect: string;
  reversibility: "easy" | "moderate" | "hard";
}

export interface ComplexityIntervention {
  id: string;
  timing: "prelaunch" | "launch" | "postlaunch";
  label: string;
  description: string;
  intendedImpacts: Record<string, number>;
  tradeoffs: string[];
}

export interface ComplexityScenarioDefinition {
  id: ComplexityScenarioId;
  label: string;
  description: string;
  shocks?: Record<string, number>;
}

export interface ComplexityTriggeredRule {
  agentId: string;
  ruleId: string;
  move: string;
}

export interface ComplexitySimulationStep {
  step: number;
  state: Record<string, number>;
  delta: Record<string, number>;
  triggeredRules: ComplexityTriggeredRule[];
  events: string[];
  regimeSignals: string[];
}

export interface ComplexityScenarioRun {
  id: ComplexityScenarioId;
  label: string;
  description: string;
  steps: ComplexitySimulationStep[];
  finalState: Record<string, number>;
  dominantRegimeId: string | null;
  outcomeSummary: string;
}

export interface ComplexityRegime {
  id: string;
  label: string;
  kind: ComplexityRegimeKind;
  severity: "low" | "medium" | "high";
  evidence: string[];
}

export interface ComplexityAnalysisResult {
  analysisMode: "complexity";
  modelKind: "bounded_adaptive_simulation";
  title: string;
  executiveSummary: string;
  agentsUsed: ComplexityAgent[];
  assumptions: string[];
  stateVariables: ComplexityStateVariable[];
  feedbackLoops: ComplexityFeedbackLoop[];
  tippingPoints: ComplexityTippingPoint[];
  pathDependencies: ComplexityPathDependency[];
  interventions: ComplexityIntervention[];
  scenarios: ComplexityScenarioRun[];
  dominantRegimes: ComplexityRegime[];
  earlySignals: string[];
  regimeShiftTriggers: string[];
  resilienceScore: number;
  adaptationCapacity: number;
  lockInRisk: number;
  cascadeRisk: number;
  optionalityScore: number;
  confidence: number;
  verdict: ProductDecision;
  verdictLabel: string;
  keyInsights: string[];
  recommendations: string[];
  runtimeStats?: AnalysisRuntimeStats;
  rawThinking: string;
}

export type IntegratedFinalDecision = "launch" | "pilot" | "revise" | "pause" | "kill";
export type ConvergenceExpectation =
  | "toward_recommended_equilibrium"
  | "toward_bad_equilibrium"
  | "cycling"
  | "fragmented"
  | "non_convergent";

export interface IntegratedAnalysisResult {
  analysisMode: "integrated";
  modelKind: "arthur_sandholm_hybrid";
  title: string;
  executiveSummary: string;
  nash: AnalysisResult;
  complexity: ComplexityAnalysisResult;
  staticStabilityScore: number;
  dynamicStabilityScore: number;
  reachabilityOfNash: number;
  adaptationPressure: number;
  basinOfAttraction: "wide" | "narrow" | "fragmented";
  pathDependenceRisk: number;
  lockInRisk: number;
  regimeShiftRisk: number;
  convergenceExpectation: ConvergenceExpectation;
  agreementLevel: "high" | "medium" | "low";
  confidence: number;
  verdict: ProductDecision;
  finalDecision: IntegratedFinalDecision;
  decisionLabel: string;
  whereAnalysesAgree: string[];
  contradictions: string[];
  productImplications: string[];
  preDevelopmentChanges: string[];
  pilotDesign: string[];
  earlySignalsToWatch: string[];
  finalRecommendation: string;
  runtimeStats?: AnalysisRuntimeStats;
  rawThinking: string;
}

export type AnyAnalysisResult = AnalysisResult | ComplexityAnalysisResult | IntegratedAnalysisResult;
