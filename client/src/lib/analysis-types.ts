export type AnalysisType = "strategy" | "feature";
export type AnalysisStatus = "pending" | "running" | "done" | "error" | "cancelled";

export interface Analysis {
  id: number;
  title: string;
  type: AnalysisType;
  description: string;
  players: string;
  context: string;
  status: AnalysisStatus;
  result: string | null;
  createdAt: number | string | Date | null;
}

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
  weight?: number;
  source?: PlayerSource;
}

export interface StrategyProfile {
  id: string;
  selections: Record<string, string>;
  payoffs: Record<string, number>;
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
  strategies: Record<string, string>;
  payoffs: Record<string, number>;
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
  playersUsed: Player[];
  aggregatedActors: string[];
  assumptions: string[];
  profiles: StrategyProfile[];
  confidence: number;
  pairwiseViews: PairwiseView[];
  sensitivityChecks: SensitivityCheck[];
  equilibria: NashScenario[];
  recommendedEquilibrium: NashScenario | null;
  nashScore: number;
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

export interface AnalysisErrorResult {
  error: string;
}

export type AnalysisProgressPhase =
  | "queued"
  | "setup"
  | "payoff"
  | "finalizing"
  | "done"
  | "error"
  | "cancelled";

export type AnalysisProgressStepId =
  | "prepare_request"
  | "setup_players"
  | "build_profiles"
  | "score_profiles"
  | "compute_equilibrium"
  | "agent_article"
  | "decision_pack";

export interface AnalysisLiveProgress {
  phase: AnalysisProgressPhase;
  phaseLabel: string;
  llmStatus: string;
  previewText: string;
  profileCount: number | null;
  profileProcessedCount: number | null;
  requiresLlmCheck: boolean;
  llmCheckMessage: string | null;
  activeStepId: AnalysisProgressStepId | null;
  completedStepIds: AnalysisProgressStepId[];
  startedAt: number;
  updatedAt: number;
  lastChunkAt: number | null;
  chunks: number;
  error: string | null;
}

export interface AnalysisStreamSnapshot {
  status: AnalysisStatus;
  result: string | null;
  progress: AnalysisLiveProgress | null;
}
