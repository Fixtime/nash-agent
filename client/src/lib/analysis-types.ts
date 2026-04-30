export type AnalysisType = "strategy" | "feature";
export type AnalysisMode = "nash" | "complexity" | "integrated";
export type AnalysisStatus = "pending" | "running" | "done" | "error" | "cancelled";

export interface Analysis {
  id: number;
  title: string;
  type: AnalysisType;
  analysisMode?: AnalysisMode;
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
  analysisMode?: "nash";
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

export interface ComplexityScenarioRun {
  id: ComplexityScenarioId;
  label: string;
  description: string;
  steps: ComplexitySimulationStep[];
  finalState: Record<string, number>;
  dominantRegimeId: string | null;
  outcomeSummary: string;
}

export interface ComplexitySimulationStep {
  step: number;
  state: Record<string, number>;
  delta: Record<string, number>;
  triggeredRules: Array<{ agentId: string; ruleId: string; move: string }>;
  events: string[];
  regimeSignals: string[];
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
  | "decision_pack"
  | "integrated_nash_setup"
  | "integrated_nash_profiles"
  | "integrated_nash_payoffs"
  | "integrated_nash_equilibrium"
  | "integrated_nash_article"
  | "integrated_nash_decision"
  | "integrated_complexity_setup"
  | "integrated_complexity_scenarios"
  | "integrated_complexity_simulation"
  | "integrated_complexity_regimes"
  | "integrated_complexity_article"
  | "integrated_complexity_decision"
  | "integrated_synthesis";

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
