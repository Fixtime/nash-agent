import { useEffect, useState, type ComponentType } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { saveAnalysisDraft } from "@/lib/analysis-draft";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import type {
  Analysis,
  AnalysisErrorResult,
  AnalysisLiveProgress,
  AnalysisResult,
  AnalysisStreamSnapshot,
  AnyAnalysisResult,
  ComplexityAnalysisResult,
  DecisionPack,
  IntegratedAnalysisResult,
  PairwiseView,
  PayoffCell,
  Player,
} from "@/lib/analysis-types";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
} from "recharts";
import {
  AlertTriangle,
  ArrowLeft,
  Brain,
  Clock3,
  CheckCircle2,
  ChevronRight,
  Copy,
  FileDown,
  Layers,
  Lightbulb,
  PauseCircle,
  RefreshCw,
  Settings2,
  Shield,
  Sparkles,
  Target,
  TrendingUp,
  Users,
  XCircle,
} from "lucide-react";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getCreatedAtMs(value: Analysis["createdAt"]): number | null {
  if (!value) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatProfileProgress(progress: AnalysisLiveProgress | null): string {
  if (typeof progress?.profileCount !== "number") return "—";

  if (progress.phase === "payoff" && typeof progress.profileProcessedCount === "number") {
    return `${progress.profileProcessedCount} из ${progress.profileCount} проф.`;
  }

  return `${progress.profileCount} проф.`;
}

function copyViaExecCommand(text: string): boolean {
  if (typeof document === "undefined") return false;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy fallback for embedded browsers.
    }
  }

  return copyViaExecCommand(text);
}

function isAnalysisResult(value: unknown): value is AnalysisResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AnalysisResult).nashScore === "number" &&
    Array.isArray((value as AnalysisResult).equilibria)
  );
}

function isComplexityResult(value: unknown): value is ComplexityAnalysisResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as ComplexityAnalysisResult).analysisMode === "complexity" &&
    Array.isArray((value as ComplexityAnalysisResult).scenarios)
  );
}

function isIntegratedResult(value: unknown): value is IntegratedAnalysisResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as IntegratedAnalysisResult).analysisMode === "integrated" &&
    (value as IntegratedAnalysisResult).modelKind === "arthur_sandholm_hybrid" &&
    typeof (value as IntegratedAnalysisResult).reachabilityOfNash === "number"
  );
}

function parseErrorMessage(analysis: Analysis): string | null {
  if (!analysis.result) return null;

  try {
    const parsed = JSON.parse(analysis.result) as Partial<AnalysisErrorResult>;
    return typeof parsed.error === "string" && parsed.error.trim()
      ? parsed.error.trim()
      : null;
  } catch {
    return null;
  }
}

function parseResult(analysis: Analysis): AnyAnalysisResult | null {
  if (!analysis.result) return null;
  try {
    const parsed = JSON.parse(analysis.result) as unknown;
    if (isIntegratedResult(parsed)) return parsed;
    if (isComplexityResult(parsed)) return parsed;
    return isAnalysisResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseSubmittedPlayers(analysis: Analysis): Player[] {
  try {
    const parsed = JSON.parse(analysis.players) as Partial<Player>[];
    if (!Array.isArray(parsed)) return [];

    return parsed.map((player, index) => ({
      id: player.id || `p${index + 1}`,
      name: player.name || `Игрок ${index + 1}`,
      type: player.type || "other",
      strategies: Array.isArray(player.strategies) ? player.strategies : [],
      incentives: player.incentives || "",
      source: player.source,
      weight: player.weight,
      tier: player.tier,
    }));
  } catch {
    return [];
  }
}

function getDisplayPlayers(analysis: Analysis, result: AnalysisResult): Player[] {
  if (Array.isArray(result.playersUsed) && result.playersUsed.length > 0) {
    return result.playersUsed;
  }

  return parseSubmittedPlayers(analysis);
}

function getPairwiseViews(result: AnalysisResult): PairwiseView[] {
  if (Array.isArray(result.pairwiseViews) && result.pairwiseViews.length > 0) {
    return result.pairwiseViews;
  }

  if (result.payoffMatrix?.length && result.matrixPlayers?.length >= 2) {
    return [
      {
        players: [result.matrixPlayers[0], result.matrixPlayers[1]],
        matrix: result.payoffMatrix,
        matrixStrategies: result.matrixStrategies || {},
      },
    ];
  }

  return [];
}

function getConfidence(result: AnalysisResult) {
  if (typeof result.confidence === "number") {
    return clamp(Math.round(result.confidence), 0, 100);
  }

  return clamp(Math.round(result.nashScore * 0.82), 30, 85);
}

function getProfilesCount(result: AnalysisResult, pairwiseViews: PairwiseView[]) {
  if (Array.isArray(result.profiles) && result.profiles.length > 0) {
    return result.profiles.length;
  }

  const firstView = pairwiseViews[0];
  if (!firstView) return 0;

  return firstView.matrix.reduce((count, row) => count + row.length, 0);
}

function getUniqueAggregatedActors(result: AnalysisResult) {
  return Array.isArray(result.aggregatedActors)
    ? Array.from(new Set(result.aggregatedActors.filter(Boolean)))
    : [];
}

function getUniqueAssumptions(result: AnalysisResult) {
  return Array.isArray(result.assumptions)
    ? Array.from(new Set(result.assumptions.filter(Boolean)))
    : [];
}

function getPlayerTypeLabel(type: Player["type"]) {
  switch (type) {
    case "competitor":
      return "конкурент";
    case "partner":
      return "партнёр";
    case "regulator":
      return "регулятор";
    case "user":
      return "пользователь";
    case "platform":
      return "платформа";
    default:
      return "прочее";
  }
}

const VERDICT_CONFIG = {
  launch: {
    label: "Запускать",
    icon: CheckCircle2,
    cls: "verdict-launch",
    desc: "Найдено устойчивое положение. Стратегию можно передавать в разработку и готовить к запуску.",
  },
  revise: {
    label: "ДОРАБОТАТЬ",
    icon: AlertTriangle,
    cls: "verdict-revise",
    desc: "Позиция существует, но она хрупкая. Нужны изменения в дизайне хода или защите от контрмер.",
  },
  pause: {
    label: "ПАУЗА",
    icon: PauseCircle,
    cls: "verdict-pause",
    desc: "Риск выше приемлемого. Лучше дождаться дополнительных данных или изменения условий игры.",
  },
  kill: {
    label: "ОТМЕНИТЬ",
    icon: XCircle,
    cls: "verdict-kill",
    desc: "В текущей форме запуск не создаёт устойчивой позиции и проигрывает более сильным ответам других игроков.",
  },
} as const;

const RISK_CONFIG = {
  low: { label: "Низкий", cls: "risk-low" },
  medium: { label: "Средний", cls: "risk-medium" },
  high: { label: "Высокий", cls: "risk-high" },
  critical: { label: "Критический", cls: "risk-critical" },
} as const;

const STABILITY_CONFIG = {
  stable: { label: "Стабильное", cls: "stability-stable" },
  unstable: { label: "Нестабильное", cls: "stability-unstable" },
  conditional: { label: "Условное", cls: "stability-conditional" },
} as const;

function NashScoreGauge({ score }: { score: number }) {
  const angle = -135 + (score / 100) * 270;

  function getColor() {
    if (score >= 80) return "hsl(142 70% 45%)";
    if (score >= 60) return "hsl(38 92% 50%)";
    if (score >= 40) return "hsl(20 80% 55%)";
    return "hsl(0 70% 55%)";
  }

  const pct = Math.round(score);

  return (
    <div className="flex flex-col items-center" data-testid="nash-score-gauge">
      <svg viewBox="0 0 120 80" className="w-40 h-28">
        <path
          d="M 15 75 A 45 45 0 1 1 105 75"
          fill="none"
          stroke="hsl(220 15% 18%)"
          strokeWidth="10"
          strokeLinecap="round"
        />
        <path
          d="M 15 75 A 45 45 0 1 1 105 75"
          fill="none"
          stroke={getColor()}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${(score / 100) * 141.4} 141.4`}
          style={{ transition: "stroke-dasharray 1s ease-out" }}
        />
        <line
          x1="60"
          y1="75"
          x2={60 + 30 * Math.cos(((angle - 90) * Math.PI) / 180)}
          y2={75 + 30 * Math.sin(((angle - 90) * Math.PI) / 180)}
          stroke={getColor()}
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="60" cy="75" r="4" fill={getColor()} />
        <text
          x="60"
          y="60"
          textAnchor="middle"
          fontSize="18"
          fontWeight="700"
          fontFamily="JetBrains Mono, monospace"
          fill={getColor()}
        >
          {pct}
        </text>
        <text x="60" y="70" textAnchor="middle" fontSize="5" fill="hsl(220 10% 52%)">
          ИНДЕКС НЭША
        </text>
      </svg>
      <div className="flex justify-between w-40 -mt-2 px-1">
        <span className="text-xs text-muted-foreground font-mono">0</span>
        <span className="text-xs text-muted-foreground font-mono">100</span>
      </div>
    </div>
  );
}

function PairwiseMatrix({
  view,
  playersById,
}: {
  view: PairwiseView;
  playersById: Map<string, Player>;
}) {
  const [p1id, p2id] = view.players;
  const p1 = playersById.get(p1id);
  const p2 = playersById.get(p2id);
  const p1name = p1?.name || p1id;
  const p2name = p2?.name || p2id;
  const p1strategies = view.matrixStrategies[p1id] || p1?.strategies || [];
  const p2strategies = view.matrixStrategies[p2id] || p2?.strategies || [];

  function cellClass(cell: PayoffCell) {
    const focalPayoff = cell.payoffs[p1id] ?? 0;
    const base =
      focalPayoff > 0
        ? "payoff-positive"
        : focalPayoff < 0
          ? "payoff-negative"
          : "payoff-neutral";
    return `${base} ${cell.isNash ? "payoff-nash" : ""}`;
  }

  return (
    <div className="overflow-x-auto" data-testid={`pairwise-matrix-${p1id}-${p2id}`}>
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr>
            <th className="p-2 text-muted-foreground text-left font-medium">
              <span className="text-primary">{p1name}</span> / {p2name}
            </th>
            {p2strategies.map((strategy) => (
              <th key={strategy} className="p-2 text-center text-muted-foreground font-medium border border-border">
                {strategy}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {p1strategies.map((strategy, rowIndex) => (
            <tr key={strategy}>
              <td className="p-2 text-muted-foreground font-medium border border-border">
                {strategy}
              </td>
              {p2strategies.map((columnStrategy, columnIndex) => {
                const cell = view.matrix[rowIndex]?.[columnIndex];

                if (!cell) {
                  return (
                    <td key={columnStrategy} className="p-2 border border-border text-center text-muted-foreground">
                      —
                    </td>
                  );
                }

                const p1payoff = cell.payoffs[p1id] ?? 0;
                const p2payoff = cell.payoffs[p2id] ?? 0;

                return (
                  <td
                    key={columnStrategy}
                    className={`p-2 text-center border border-border font-mono relative rounded-sm ${cellClass(cell)}`}
                    title={cell.isNash ? "Равновесие Нэша" : ""}
                    data-testid={`matrix-cell-${rowIndex}-${columnIndex}`}
                  >
                    ({p1payoff}, {p2payoff})
                    {cell.isNash && (
                      <span className="absolute top-0.5 right-0.5 text-primary" title="Равновесие Нэша">
                        ★
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground mt-2">
        Формат: (<span className="text-primary">{p1name}</span>, {p2name}) · ★ равновесие Нэша
      </p>
    </div>
  );
}

function EquilibriaList({
  result,
  playersById,
}: {
  result: AnalysisResult;
  playersById: Map<string, Player>;
}) {
  return (
    <div className="space-y-3" data-testid="equilibria-list">
      {result.equilibria.map((equilibrium, index) => {
        const isRecommended =
          result.recommendedEquilibrium &&
          JSON.stringify(equilibrium.strategies) === JSON.stringify(result.recommendedEquilibrium.strategies);
        const stability = STABILITY_CONFIG[equilibrium.stability as keyof typeof STABILITY_CONFIG];
        const profitableDeviations = equilibrium.deviations?.filter((item) => item.profitable).length || 0;

        return (
          <div
            key={`${equilibrium.profileId || "eq"}-${index}`}
            className={`p-3 rounded-lg border ${
              isRecommended ? "border-primary/40 bg-primary/5" : "border-border bg-card"
            }`}
            data-testid={`equilibrium-${index}`}
          >
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="flex items-center gap-2 flex-wrap">
                {isRecommended && <Badge className="text-xs">Рекомендуемое</Badge>}
                <span className={`text-xs font-medium ${stability?.cls || ""}`}>
                  {stability?.label || equilibrium.stability}
                </span>
                {equilibrium.isNash ? (
                  <Badge variant="outline" className="text-xs border-primary/40 text-primary">
                    Равновесие Нэша
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs">
                    Приближение
                  </Badge>
                )}
                {equilibrium.profileId && (
                  <Badge variant="secondary" className="text-xs font-mono">
                    {equilibrium.profileId}
                  </Badge>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-2 mb-2">
              {Object.entries(equilibrium.strategies).map(([playerId, strategy]) => {
                const playerName = playersById.get(playerId)?.name || playerId;
                return (
                  <div key={playerId} className="flex items-center gap-1 text-xs">
                    <span className="text-muted-foreground">{playerName}:</span>
                    <span className="font-medium text-foreground">{strategy}</span>
                    <span className="text-muted-foreground/60 font-mono">
                      ({equilibrium.payoffs[playerId] >= 0 ? "+" : ""}
                      {equilibrium.payoffs[playerId]})
                    </span>
                  </div>
                );
              })}
            </div>

            {equilibrium.deviations && equilibrium.deviations.length > 0 && (
              <p className="text-xs text-muted-foreground mb-2">
                Выгодных односторонних отклонений:{" "}
                <span className="font-mono text-foreground">{profitableDeviations}</span>
              </p>
            )}

            <p className="text-xs text-muted-foreground">{equilibrium.description}</p>
          </div>
        );
      })}
    </div>
  );
}

function getDecisionTargetName(targetPlayerId: string, playersById: Map<string, Player>) {
  if (targetPlayerId === "system") return "Система игры";
  return playersById.get(targetPlayerId)?.name || targetPlayerId;
}

function getEffortLabel(effort: string) {
  switch (effort) {
    case "S":
      return "S";
    case "L":
      return "L";
    default:
      return "M";
  }
}

const DECISION_TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/Support ticket volume per 100 orders/gi, "Количество обращений в поддержку на 100 заказов"],
  [/Support tickets grow/gi, "Обращения в поддержку растут"],
  [/Checkout conversion rate/gi, "Конверсия чекаута"],
  [/Conversion uplift/gi, "Прирост конверсии"],
  [/Drop-off rate/gi, "Доля отвалов"],
  [/API uptime/gi, "Доступность API"],
  [/error rate/gi, "доля ошибок"],
  [/latency/gi, "задержка"],
  [/fallback-механизм/gi, "резервный механизм"],
  [/fallback mechanism/gi, "резервный механизм"],
  [/fallback/gi, "резервный сценарий"],
  [/per 100 orders/gi, "на 100 заказов"],
];

function localizeDecisionText(value: string): string {
  return DECISION_TEXT_REPLACEMENTS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );
}

function DecisionPackSection({
  decisionPack,
  playersById,
}: {
  decisionPack: DecisionPack;
  playersById: Map<string, Player>;
}) {
  const moves = decisionPack.topStrategicMoves || [];
  const experiments = decisionPack.experimentPlan || [];
  const guardrails = decisionPack.launchGuardrails || [];
  const playbook = decisionPack.counterMovePlaybook || [];
  const openQuestions = decisionPack.openQuestions || [];

  return (
    <Card className="mb-6 border-primary/25 bg-primary/5" data-testid="decision-pack">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 max-w-3xl">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <Badge className="text-xs">Что делать дальше</Badge>
              {decisionPack.targetEquilibrium && (
                <Badge variant="outline" className="text-xs font-mono">
                  цель {decisionPack.targetEquilibrium}
                </Badge>
              )}
            </div>
            <CardTitle className="text-base font-semibold">План действий для продакт-менеджера</CardTitle>
            <CardDescription className="text-sm mt-2 leading-relaxed">
              {localizeDecisionText(decisionPack.executiveSummary)}
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {decisionPack.whyNow ? (
          <div className="rounded-lg border border-primary/20 bg-background/50 p-3">
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground mb-1">
              Почему сейчас
            </div>
            <p className="text-sm text-foreground/90 leading-relaxed">{localizeDecisionText(decisionPack.whyNow)}</p>
          </div>
        ) : null}

        {moves.length > 0 ? (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Стратегические ходы</h2>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              {moves.map((move) => {
                const payoffDeltas = Object.entries(move.expectedPayoffDelta || {})
                  .filter(([, value]) => value !== 0)
                  .slice(0, 4);

                return (
                  <div key={`${move.priority}-${move.title}`} className="rounded-lg border border-border/70 bg-background/60 p-3">
                    <div className="flex items-center gap-1.5 flex-wrap mb-2">
                      <Badge variant="secondary" className="text-xs font-mono">
                        P{move.priority}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        усилие {getEffortLabel(move.effort)}
                      </Badge>
                      <Badge variant="outline" className="text-xs font-mono">
                        +{move.expectedNashScoreDelta} к индексу
                      </Badge>
                      <Badge variant="outline" className="text-xs font-mono">
                        уверенность {Math.round(move.confidence)}
                      </Badge>
                    </div>

                    <div className="text-sm font-medium text-foreground leading-snug">{localizeDecisionText(move.title)}</div>
                    <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{localizeDecisionText(move.objective)}</p>

                    <div className="mt-3 text-xs">
                      <span className="text-muted-foreground">Цель: </span>
                      <span className="text-foreground">{getDecisionTargetName(move.targetPlayerId, playersById)}</span>
                    </div>
                    <p className="text-xs text-foreground/80 mt-1.5 leading-relaxed">{localizeDecisionText(move.changesIncentiveHow)}</p>

                    {payoffDeltas.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        {payoffDeltas.map(([playerId, value]) => (
                          <Badge key={playerId} variant="secondary" className="text-xs font-mono">
                            {playersById.get(playerId)?.name || playerId} {value > 0 ? "+" : ""}
                            {value}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {experiments.length > 0 ? (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Target className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">План проверки</h2>
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {experiments.map((experiment, index) => (
                <div key={`${index}-${experiment.metric}`} className="rounded-lg border border-border/70 bg-background/60 p-3">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <Badge variant="secondary" className="text-xs font-mono">
                      E{index + 1}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{experiment.timebox}</span>
                  </div>
                  <p className="text-sm text-foreground/90 leading-relaxed">{localizeDecisionText(experiment.hypothesis)}</p>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-muted-foreground mb-0.5">Метрика</div>
                      <div className="text-foreground/85">{localizeDecisionText(experiment.metric)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Ограничитель</div>
                      <div className="text-foreground/85">{localizeDecisionText(experiment.guardrailMetric)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Успех</div>
                      <div className="text-foreground/85">{localizeDecisionText(experiment.successCriterion)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Остановка</div>
                      <div className="text-foreground/85">{localizeDecisionText(experiment.killCriterion)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          {guardrails.length > 0 ? (
            <div className="rounded-lg border border-border/70 bg-background/60 p-3">
              <div className="flex items-center gap-2 mb-2">
                <Shield className="w-4 h-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">Ограничители запуска</h2>
              </div>
              <div className="space-y-2">
                {guardrails.map((guardrail, index) => (
                  <div key={`${index}-${guardrail}`} className="flex gap-2 text-xs leading-relaxed">
                    <span className="font-mono text-primary">{index + 1}.</span>
                    <span className="text-foreground/85">{localizeDecisionText(guardrail)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {playbook.length > 0 ? (
            <div className="rounded-lg border border-border/70 bg-background/60 p-3">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-yellow-500" />
                <h2 className="text-sm font-semibold text-foreground">Сценарии контрходов</h2>
              </div>
              <div className="space-y-3">
                {playbook.map((item, index) => (
                  <div key={`${index}-${item.threat}`} className="text-xs leading-relaxed">
                    <div className="font-medium text-foreground">{localizeDecisionText(item.threat)}</div>
                    <div className="mt-1 text-muted-foreground">Сигнал: {localizeDecisionText(item.earlySignal)}</div>
                    <div className="mt-1 text-foreground/85">Ответ: {localizeDecisionText(item.mitigation)}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {openQuestions.length > 0 ? (
            <div className="rounded-lg border border-border/70 bg-background/60 p-3">
              <div className="flex items-center gap-2 mb-2">
                <Lightbulb className="w-4 h-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">Открытые вопросы</h2>
              </div>
              <div className="space-y-2">
                {openQuestions.map((question, index) => (
                  <div key={`${index}-${question}`} className="flex gap-2 text-xs leading-relaxed">
                    <span className="font-mono text-primary">{index + 1}.</span>
                    <span className="text-foreground/85">{localizeDecisionText(question)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function ComplexityMetricCard({
  title,
  value,
  description,
  inverse = false,
}: {
  title: string;
  value: number;
  description: string;
  inverse?: boolean;
}) {
  const colorClass = inverse
    ? value >= 70 ? "text-red-400" : value >= 45 ? "text-amber-400" : "text-emerald-400"
    : value >= 70 ? "text-emerald-400" : value >= 45 ? "text-amber-400" : "text-red-400";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold font-mono ${colorClass}`}>{Math.round(value)}</div>
        <Progress value={clamp(value, 0, 100)} className="h-2 mt-3" />
        <p className="text-xs text-muted-foreground mt-2">{description}</p>
      </CardContent>
    </Card>
  );
}

function ComplexityResultView({ analysis, result }: { analysis: Analysis; result: ComplexityAnalysisResult }) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [copiedRawThinking, setCopiedRawThinking] = useState(false);
  const [isCaseSourceOpen, setIsCaseSourceOpen] = useState(false);
  const verdictConfig = VERDICT_CONFIG[result.verdict as keyof typeof VERDICT_CONFIG] || VERDICT_CONFIG.revise;
  const VerdictIcon = verdictConfig.icon;
  const rawThinking = result.rawThinking || "";

  async function handleCopyRawThinking() {
    if (!rawThinking) return;

    const copied = await copyText(rawThinking);
    if (!copied) {
      toast({
        title: "Не удалось скопировать текст",
        description: "Буфер обмена недоступен в этом браузере",
        variant: "destructive",
      });
      return;
    }

    setCopiedRawThinking(true);
    window.setTimeout(() => setCopiedRawThinking(false), 1600);
    toast({
      title: "Текст скопирован",
      description: "Развёрнутый вывод уже в буфере обмена",
    });
  }

  function handleRestartWithAdjustedConditions() {
    saveAnalysisDraft({
      type: analysis.type,
      analysisMode: "complexity",
      title: analysis.title,
      description: analysis.description,
      context: analysis.context,
    });
    setIsCaseSourceOpen(false);
    setLocation("/");
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8" data-testid="complexity-analysis-view">
      <Button variant="ghost" size="sm" onClick={() => setLocation("/history")} className="mb-6 -ml-2">
        <ArrowLeft className="w-4 h-4 mr-1.5" />
        Все кейсы
      </Button>

      <div className="mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <Badge variant="outline" className="text-xs">
                {analysis.type === "strategy" ? "Стратегия" : "Фича"}
              </Badge>
              <Badge variant="secondary" className="text-xs">Экономика сложности</Badge>
              <Badge variant="secondary" className="text-xs gap-1">
                <Users className="w-3 h-3" />
                {result.agentsUsed.length} игроков
              </Badge>
              <Badge variant="secondary" className="text-xs gap-1">
                <Layers className="w-3 h-3" />
                {result.scenarios.length} сценария
              </Badge>
            </div>
            <h1 className="text-xl font-bold text-foreground">{analysis.title}</h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-3xl">{result.executiveSummary}</p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-10 w-10 text-muted-foreground"
              onClick={() => setIsCaseSourceOpen(true)}
              title="Исходные данные кейса"
              aria-label="Исходные данные кейса"
            >
              <Settings2 className="w-4 h-4" />
            </Button>
            <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border font-bold text-sm ${verdictConfig.cls}`}>
              <VerdictIcon className="w-4 h-4" />
              {result.verdictLabel || verdictConfig.label}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4 mb-6">
        <ComplexityMetricCard title="Устойчивость к сбоям" value={result.resilienceScore} description="Способность траектории пережить стресс-сценарий." />
        <ComplexityMetricCard title="Адаптация" value={result.adaptationCapacity} description="Насколько быстро игроки меняют поведение без развала системы." />
        <ComplexityMetricCard title="Захват траектории" value={result.lockInRisk} description="Риск закрепить дорогую раннюю траекторию." inverse />
        <ComplexityMetricCard title="Каскадный сбой" value={result.cascadeRisk} description="Риск распространения локальной проблемы по системе." inverse />
        <ComplexityMetricCard title="Манёвры" value={result.optionalityScore} description="Сколько будущих ходов остаётся после запуска." />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Users className="w-4 h-4 text-primary" />
              Адаптивные игроки
            </CardTitle>
            <CardDescription className="text-xs">Игроки, правила адаптации и вероятные ходы.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {result.agentsUsed.map((agent) => (
              <div key={agent.id} className="rounded-lg border border-border/70 bg-muted/20 p-3">
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <div className="text-sm font-medium text-foreground">{agent.name}</div>
                  <Badge variant="secondary" className="text-xs">вес {agent.weight}</Badge>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {agent.likelyMoves.slice(0, 3).map((move) => (
                    <Badge key={move} variant="outline" className="text-xs whitespace-normal break-words">
                      {move}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              Переменные состояния
            </CardTitle>
            <CardDescription className="text-xs">Что меняется во времени и влияет на траекторию запуска.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {result.stateVariables.map((variable) => (
              <div key={variable.id}>
                <div className="flex items-center justify-between gap-3 mb-1">
                  <span className="text-sm text-foreground">{variable.name}</span>
                  <span className="text-xs font-mono text-muted-foreground">{variable.initialValue}</span>
                </div>
                <Progress value={variable.initialValue} className="h-2" />
                <p className="text-xs text-muted-foreground mt-1">{variable.description}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Сценарии адаптивной симуляции</CardTitle>
          <CardDescription className="text-xs">Три траектории по 8 шагов: состояние системы, события и сигналы смены режима.</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue={result.scenarios[0]?.id || "baseline"}>
            <TabsList className="h-auto flex-wrap justify-start">
              {result.scenarios.map((scenario) => (
                <TabsTrigger key={scenario.id} value={scenario.id} className="text-xs">
                  {scenario.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {result.scenarios.map((scenario) => (
              <TabsContent key={scenario.id} value={scenario.id}>
                <div className="rounded-lg border border-border/70 overflow-hidden">
                  <div className="p-3 border-b border-border/70 bg-muted/20">
                    <p className="text-sm font-medium text-foreground">{scenario.outcomeSummary}</p>
                    <p className="text-xs text-muted-foreground mt-1">{scenario.description}</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border/70 text-muted-foreground">
                          <th className="p-2 text-left font-medium">Шаг</th>
                          <th className="p-2 text-left font-medium">События</th>
                          <th className="p-2 text-left font-medium">Сигналы</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scenario.steps.map((step) => (
                          <tr key={step.step} className="border-b border-border/40 align-top">
                            <td className="p-2 font-mono text-foreground">{step.step}</td>
                            <td className="p-2 text-foreground/85">{step.events.join("; ") || "Без сильных изменений"}</td>
                            <td className="p-2 text-muted-foreground">{step.regimeSignals.join("; ") || "Нет пороговых сигналов"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Обратные связи и пороговые переломы</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {[...result.feedbackLoops.map((loop) => `${loop.label}: ${loop.description}`), ...result.tippingPoints.map((point) => `${point.label}: ${point.consequence}`)].map((item, index) => (
              <div key={`${index}-${item}`} className="flex gap-2 text-sm">
                <span className="text-primary font-mono text-xs mt-0.5">{index + 1}.</span>
                <span className="text-foreground/85 leading-relaxed">{item}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Режимы системы</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {result.dominantRegimes.map((regime) => (
              <div key={regime.id} className="rounded-lg border border-border/70 bg-muted/20 p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-foreground">{regime.label}</span>
                  <Badge variant="outline" className="text-xs">{regime.severity === "high" ? "высокая важность" : regime.severity === "medium" ? "средняя важность" : "низкая важность"}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{regime.evidence.join(" ")}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Lightbulb className="w-4 h-4 text-primary" />
            Выводы и рекомендации
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="space-y-2">
            {result.keyInsights.map((insight, index) => (
              <div key={`${index}-${insight}`} className="flex gap-2 text-sm">
                <span className="text-primary font-mono text-xs mt-0.5">{index + 1}.</span>
                <span className="text-foreground/90 leading-relaxed">{insight}</span>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            {result.recommendations.map((recommendation, index) => (
              <div key={`${index}-${recommendation}`} className="flex gap-2.5 p-2.5 rounded-lg bg-muted/50">
                <ChevronRight className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                <span className="text-sm text-foreground/90 leading-relaxed">{recommendation}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {rawThinking && (
        <Card className="mb-4">
          <CardHeader className="pb-3 flex-row items-center justify-between space-y-0 gap-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Brain className="w-4 h-4 text-muted-foreground" />
              Развёрнутый анализ агента
            </CardTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              onClick={handleCopyRawThinking}
              title={copiedRawThinking ? "Скопировано" : "Скопировать итоговый вывод"}
              aria-label={copiedRawThinking ? "Скопировано" : "Скопировать итоговый вывод"}
            >
              {copiedRawThinking ? <CheckCircle2 className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
            </Button>
          </CardHeader>
          <CardContent>
            <div className="w-full rounded-lg bg-muted/30 px-5 py-4 text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
              {rawThinking}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="mt-8 flex justify-center">
        <Button asChild variant="outline" className="gap-2">
          <a href={`/api/analyses/${analysis.id}/pdf`} download data-testid="download-analysis-pdf">
            <FileDown className="w-4 h-4" />
            Скачать PDF-документ
          </a>
        </Button>
      </div>

      <Dialog open={isCaseSourceOpen} onOpenChange={setIsCaseSourceOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Исходные данные кейса</DialogTitle>
            <DialogDescription>Здесь можно посмотреть исходные поля текущего кейса и перенести их в новый анализ для правок.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Название</div>
              <div className="rounded-lg border border-border/70 bg-muted/30 px-4 py-3 text-sm text-foreground">{analysis.title || "Без названия"}</div>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Описание</div>
              <ScrollArea className="h-48 rounded-lg border border-border/70 bg-muted/30">
                <div className="px-4 py-3 text-sm leading-relaxed text-foreground whitespace-pre-wrap">{analysis.description || "Не заполнено"}</div>
              </ScrollArea>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Контекст</div>
              <ScrollArea className="h-40 rounded-lg border border-border/70 bg-muted/30">
                <div className="px-4 py-3 text-sm leading-relaxed text-foreground whitespace-pre-wrap">{analysis.context || "Не заполнено"}</div>
              </ScrollArea>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setIsCaseSourceOpen(false)}>
              Закрыть
            </Button>
            <Button type="button" onClick={handleRestartWithAdjustedConditions}>
              Поменять условия анализа
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function getBasinLabel(value: IntegratedAnalysisResult["basinOfAttraction"]) {
  if (value === "wide") return "Широкая";
  if (value === "narrow") return "Узкая";
  return "Фрагментированная";
}

function getAgreementLabel(value: IntegratedAnalysisResult["agreementLevel"]) {
  if (value === "high") return "Высокая";
  if (value === "medium") return "Средняя";
  return "Низкая";
}

function getConvergenceLabel(value: IntegratedAnalysisResult["convergenceExpectation"]) {
  switch (value) {
    case "toward_recommended_equilibrium":
      return "Движение к рекомендованному равновесию";
    case "toward_bad_equilibrium":
      return "Риск плохого равновесия";
    case "cycling":
      return "Колебания поведения игроков";
    case "fragmented":
      return "Фрагментация траектории";
    case "non_convergent":
      return "Нет устойчивой траектории";
    default:
      return "Траектория неопределённа";
  }
}

function IntegratedListCard({
  title,
  items,
  icon: Icon,
}: {
  title: string;
  items: string[];
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Icon className="w-4 h-4 text-primary" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.length > 0 ? (
          items.map((item, index) => (
            <div key={`${index}-${item}`} className="flex gap-2 text-sm">
              <span className="text-primary font-mono text-xs mt-0.5">{index + 1}.</span>
              <span className="text-foreground/90 leading-relaxed">{item}</span>
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">Нет отдельных пунктов.</p>
        )}
      </CardContent>
    </Card>
  );
}

function IntegratedResultView({ analysis, result }: { analysis: Analysis; result: IntegratedAnalysisResult }) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [copiedRawThinking, setCopiedRawThinking] = useState(false);
  const [isCaseSourceOpen, setIsCaseSourceOpen] = useState(false);
  const verdictConfig = VERDICT_CONFIG[result.verdict as keyof typeof VERDICT_CONFIG] || VERDICT_CONFIG.revise;
  const VerdictIcon = verdictConfig.icon;
  const rawThinking = result.rawThinking || "";

  async function handleCopyRawThinking() {
    if (!rawThinking) return;

    const copied = await copyText(rawThinking);
    if (!copied) {
      toast({
        title: "Не удалось скопировать текст",
        description: "Буфер обмена недоступен в этом браузере",
        variant: "destructive",
      });
      return;
    }

    setCopiedRawThinking(true);
    window.setTimeout(() => setCopiedRawThinking(false), 1600);
    toast({
      title: "Текст скопирован",
      description: "Совмещённый вывод уже в буфере обмена",
    });
  }

  function handleRestartWithAdjustedConditions() {
    saveAnalysisDraft({
      type: analysis.type,
      analysisMode: "integrated",
      title: analysis.title,
      description: analysis.description,
      context: analysis.context,
    });
    setIsCaseSourceOpen(false);
    setLocation("/");
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8" data-testid="integrated-analysis-view">
      <Button variant="ghost" size="sm" onClick={() => setLocation("/history")} className="mb-6 -ml-2">
        <ArrowLeft className="w-4 h-4 mr-1.5" />
        Все кейсы
      </Button>

      <div className="mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <Badge variant="outline" className="text-xs">
                {analysis.type === "strategy" ? "Стратегия" : "Фича"}
              </Badge>
              <Badge variant="secondary" className="text-xs">Совмещённый анализ</Badge>
              <Badge variant="secondary" className="text-xs gap-1">
                <Users className="w-3 h-3" />
                {result.nash.playersUsed.length} игроков
              </Badge>
              <Badge variant="secondary" className="text-xs gap-1">
                <Layers className="w-3 h-3" />
                {result.nash.profiles.length} профилей · {result.complexity.scenarios.length} сценария
              </Badge>
            </div>
            <h1 className="text-xl font-bold text-foreground">{analysis.title}</h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-3xl">{result.executiveSummary}</p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-10 w-10 text-muted-foreground"
              onClick={() => setIsCaseSourceOpen(true)}
              title="Исходные данные кейса"
              aria-label="Исходные данные кейса"
            >
              <Settings2 className="w-4 h-4" />
            </Button>
            <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border font-bold text-sm ${verdictConfig.cls}`}>
              <VerdictIcon className="w-4 h-4" />
              {result.decisionLabel}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <ComplexityMetricCard title="Статическая устойчивость" value={result.staticStabilityScore} description="Насколько сильным выглядит равновесие в фиксированной игре." />
        <ComplexityMetricCard title="Динамическая устойчивость" value={result.dynamicStabilityScore} description="Насколько система выдерживает адаптацию игроков." />
        <ComplexityMetricCard title="Достижимость равновесия" value={result.reachabilityOfNash} description="Вероятность прийти к целевому профилю через реальные реакции." />
        <ComplexityMetricCard title="Давление адаптации" value={result.adaptationPressure} description="Сила, с которой игроки будут менять поведение после запуска." inverse />
      </div>

      <Card className="mb-4 border-primary/30 bg-primary/5">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Target className="w-4 h-4 text-primary" />
            Сводное решение
          </CardTitle>
          <CardDescription className="text-xs">
            Математический слой: равновесие Нэша как целевой профиль, адаптивная динамика как проверка достижимости.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 lg:grid-cols-[1.2fr_0.8fr] gap-4">
          <div className="rounded-lg bg-background/50 border border-border/60 p-4">
            <p className="text-sm leading-relaxed text-foreground">{result.finalRecommendation}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg bg-muted/40 p-3">
              <div className="text-muted-foreground mb-1">Область притяжения</div>
              <div className="font-semibold text-foreground">{getBasinLabel(result.basinOfAttraction)}</div>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <div className="text-muted-foreground mb-1">Согласованность</div>
              <div className="font-semibold text-foreground">{getAgreementLabel(result.agreementLevel)}</div>
            </div>
            <div className="rounded-lg bg-muted/40 p-3 col-span-2">
              <div className="text-muted-foreground mb-1">Ожидаемая траектория</div>
              <div className="font-semibold text-foreground">{getConvergenceLabel(result.convergenceExpectation)}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        <IntegratedListCard title="Где подходы согласны" items={result.whereAnalysesAgree} icon={CheckCircle2} />
        <IntegratedListCard title="Противоречия между слоями" items={result.contradictions} icon={AlertTriangle} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-4">
        <IntegratedListCard title="Продуктовые следствия" items={result.productImplications} icon={Lightbulb} />
        <IntegratedListCard title="Что изменить до разработки" items={result.preDevelopmentChanges} icon={Settings2} />
        <IntegratedListCard title="Ранние сигналы" items={result.earlySignalsToWatch} icon={Shield} />
      </div>

      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            Дизайн пилота
          </CardTitle>
          <CardDescription className="text-xs">
            Если статический профиль хорош, но траектория узкая, пилот проверяет именно достижимость равновесия.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {result.pilotDesign.map((item, index) => (
            <div key={`${index}-${item}`} className="rounded-lg border border-border/70 bg-muted/20 p-3 text-sm text-foreground/90 leading-relaxed">
              {item}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Слой равновесия Нэша</CardTitle>
            <CardDescription className="text-xs">Фиксированная игра: игроки, стратегии, выигрыши и односторонние отклонения.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-xs">
              <Badge variant="secondary" className="justify-center">индекс {result.nash.nashScore}</Badge>
              <Badge variant="secondary" className="justify-center">достов. {result.nash.confidence}</Badge>
              <Badge variant="secondary" className="justify-center">{result.nash.equilibria.length} равн.</Badge>
            </div>
            {result.nash.keyInsights.slice(0, 4).map((item, index) => (
              <div key={`${index}-${item}`} className="flex gap-2 text-sm">
                <span className="text-primary font-mono text-xs mt-0.5">{index + 1}.</span>
                <span className="text-foreground/90 leading-relaxed">{item}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Слой экономики сложности</CardTitle>
            <CardDescription className="text-xs">Динамика: адаптация игроков, обратные связи, пороги и захват траектории.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-xs">
              <Badge variant="secondary" className="justify-center">уст. {result.complexity.resilienceScore}</Badge>
              <Badge variant="secondary" className="justify-center">адапт. {result.complexity.adaptationCapacity}</Badge>
              <Badge variant="secondary" className="justify-center">каскад {result.complexity.cascadeRisk}</Badge>
            </div>
            {result.complexity.keyInsights.slice(0, 4).map((item, index) => (
              <div key={`${index}-${item}`} className="flex gap-2 text-sm">
                <span className="text-primary font-mono text-xs mt-0.5">{index + 1}.</span>
                <span className="text-foreground/90 leading-relaxed">{item}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {rawThinking && (
        <Card className="mb-4">
          <CardHeader className="pb-3 flex-row items-center justify-between space-y-0 gap-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Brain className="w-4 h-4 text-muted-foreground" />
              Развёрнутый совмещённый вывод
            </CardTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              onClick={handleCopyRawThinking}
              title={copiedRawThinking ? "Скопировано" : "Скопировать итоговый вывод"}
              aria-label={copiedRawThinking ? "Скопировано" : "Скопировать итоговый вывод"}
            >
              {copiedRawThinking ? <CheckCircle2 className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
            </Button>
          </CardHeader>
          <CardContent>
            <div className="w-full rounded-lg bg-muted/30 px-5 py-4 text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
              {rawThinking}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="mt-8 flex justify-center">
        <Button asChild variant="outline" className="gap-2">
          <a href={`/api/analyses/${analysis.id}/pdf`} download data-testid="download-analysis-pdf">
            <FileDown className="w-4 h-4" />
            Скачать PDF-документ
          </a>
        </Button>
      </div>

      <Dialog open={isCaseSourceOpen} onOpenChange={setIsCaseSourceOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Исходные данные кейса</DialogTitle>
            <DialogDescription>Здесь можно посмотреть исходные поля текущего кейса и перенести их в новый анализ для правок.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Название</div>
              <div className="rounded-lg border border-border/70 bg-muted/30 px-4 py-3 text-sm text-foreground">{analysis.title || "Без названия"}</div>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Описание</div>
              <ScrollArea className="h-48 rounded-lg border border-border/70 bg-muted/30">
                <div className="px-4 py-3 text-sm leading-relaxed text-foreground whitespace-pre-wrap">{analysis.description || "Не заполнено"}</div>
              </ScrollArea>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Контекст</div>
              <ScrollArea className="h-40 rounded-lg border border-border/70 bg-muted/30">
                <div className="px-4 py-3 text-sm leading-relaxed text-foreground whitespace-pre-wrap">{analysis.context || "Не заполнено"}</div>
              </ScrollArea>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setIsCaseSourceOpen(false)}>
              Закрыть
            </Button>
            <Button type="button" onClick={handleRestartWithAdjustedConditions}>
              Поменять условия анализа
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      <Skeleton className="h-8 w-64" />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((value) => (
          <Skeleton key={value} className="h-32" />
        ))}
      </div>
      <Skeleton className="h-64" />
      <Skeleton className="h-56" />
      <Skeleton className="h-48" />
    </div>
  );
}

function RunningState({
  analysis,
  progress,
}: {
  analysis: Analysis;
  progress: AnalysisLiveProgress | null;
}) {
  const { toast } = useToast();
  const [now, setNow] = useState(() => Date.now());
  const [isCheckingLlm, setIsCheckingLlm] = useState(false);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  const createdAtMs = progress?.startedAt || getCreatedAtMs(analysis.createdAt);
  const elapsedMs = createdAtMs ? Math.max(0, now - createdAtMs) : 0;
  const elapsedLabel = formatElapsed(elapsedMs);
  const waitingHint = progress?.llmStatus
    || (elapsedMs < 15000
      ? "Агент формирует компактную игру и готовит запрос к языковой модели."
      : elapsedMs < 45000
        ? "Модель оценивает игроков, стратегии и профили выигрышей."
        : "Ответ от модели ещё идёт. Для локальных моделей через LM Studio это нормально.");
  const livePreview = progress?.previewText?.trim() || "";

  async function handleCheckLlm() {
    setIsCheckingLlm(true);
    try {
      const response = await apiRequest("POST", `/api/analyses/${analysis.id}/check-llm`);
      const payload = await response.json() as { model?: string };
      toast({
        title: "LLM загружена",
        description: payload.model ? `Повторяем запрос на модели ${payload.model}` : "Повторяем тот же запрос",
      });
    } catch (error) {
      toast({
        title: "LLM ещё не готова",
        description: error instanceof Error ? error.message : "Проверьте LM Studio и попробуйте снова",
        variant: "destructive",
      });
    } finally {
      setIsCheckingLlm(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <Card className="border-primary/20 bg-card/80 overflow-hidden">
        <CardContent className="p-0">
          <div className="h-1 w-full bg-border">
            <div className="h-full w-1/3 bg-primary animate-pulse" />
          </div>

          <div className="p-8 md:p-10 flex flex-col items-center gap-6 text-center">
            <div className="relative w-20 h-20">
              <div className="absolute inset-0 rounded-full border border-primary/15 bg-primary/5" />
              <div className="absolute inset-1 rounded-full border-2 border-border" />
              <div className="absolute inset-1 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              <Brain className="absolute inset-[26px] h-7 w-7 text-primary" />
            </div>

            <div className="space-y-2">
              <Badge variant="secondary" className="text-xs uppercase tracking-[0.2em]">
                {progress?.requiresLlmCheck
                  ? "Требуется проверка LLM"
                  : analysis.status === "pending"
                    ? "Подготовка модели"
                    : "Ожидание модели"}
              </Badge>
              <h1 className="text-xl font-semibold text-foreground">Ждём ответ модели</h1>
              <p className="text-sm text-muted-foreground max-w-2xl">
                Агент не завис: он обрабатывает кейс
                <span className="text-foreground"> {analysis.title}</span> и покажет результат сразу после ответа модели.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full">
              <div className="rounded-xl border border-border/70 bg-muted/20 p-4 text-left">
                <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  <Clock3 className="h-3.5 w-3.5" />
                  Таймер
                </div>
                <div className="mt-2 text-3xl font-bold font-mono text-foreground">{elapsedLabel}</div>
                <p className="mt-1 text-xs text-muted-foreground">Сколько времени мы уже ждём</p>
              </div>

              <div className="rounded-xl border border-border/70 bg-muted/20 p-4 text-left">
                <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  {progress?.phaseLabel || "Статус"}
                </div>
                <div className="mt-2 text-lg font-semibold text-foreground">
                  {analysis.status === "pending" ? "Подготавливаем запрос" : "Модель отвечает"}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{waitingHint}</p>
              </div>

              <div className="rounded-xl border border-border/70 bg-muted/20 p-4 text-left">
                <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Поток</div>
                <div className="mt-2 space-y-1.5 text-xs text-muted-foreground">
                  <p>Фаза: <span className="text-foreground">{progress?.phaseLabel || "Ожидание"}</span></p>
                  <p>Время: <span className="font-mono text-foreground">{elapsedLabel}</span></p>
                  <p>Профили: <span className="font-mono text-foreground">{formatProfileProgress(progress)}</span></p>
                  <p>Фрагменты: <span className="font-mono text-foreground">{progress?.chunks || 0}</span></p>
                  <p>Номер: <span className="font-mono text-foreground">#{analysis.id}</span></p>
                </div>
              </div>
            </div>

            {progress?.requiresLlmCheck ? (
              <div className="w-full rounded-xl border border-primary/30 bg-primary/10 p-4 text-left">
                <p className="text-sm font-medium text-foreground">LM Studio перегрузил модель</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {progress.llmCheckMessage || "Загрузите LLM в LM Studio, затем повторите текущий запрос."}
                </p>
                <Button
                  type="button"
                  className="mt-3"
                  onClick={handleCheckLlm}
                  disabled={isCheckingLlm}
                  data-testid="btn-check-loaded-llm"
                >
                  <RefreshCw className={`w-4 h-4 mr-2 ${isCheckingLlm ? "animate-spin" : ""}`} />
                  Проверить загруженную LLM
                </Button>
              </div>
            ) : null}

            <div className="w-full text-left">
              <div className="flex items-center justify-between gap-3 mb-2">
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Поток ответа модели</p>
                <p className="text-xs text-muted-foreground">
                  {livePreview ? "Токены приходят в реальном времени" : "Пока нет токенов от модели"}
                </p>
              </div>
              <ScrollArea className="h-72 rounded-xl border border-border/70 bg-muted/20 p-4">
                {livePreview ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
                    {livePreview}
                  </pre>
                ) : (
                  <div className="flex h-full min-h-40 items-center justify-center text-center text-xs text-muted-foreground">
                    Как только модель начнёт отвечать, здесь появится её текущий поток до финального JSON.
                  </div>
                )}
              </ScrollArea>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function LoadingResultState() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <Card className="border-primary/20">
        <CardContent className="py-10 flex flex-col items-center gap-4 text-center">
          <div className="relative w-14 h-14">
            <div className="absolute inset-0 rounded-full border-2 border-border" />
            <div className="absolute inset-0 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            <Sparkles className="absolute inset-3.5 w-7 h-7 text-primary" />
          </div>
          <div>
            <p className="text-sm font-medium">Ответ получен, собираем дашборд…</p>
            <p className="text-xs text-muted-foreground mt-1">
              Ещё пара мгновений, и покажем анализ Нэша в полном формате.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AnalysisView() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const id = parseInt(params.id || "0", 10);
  const [streamSnapshot, setStreamSnapshot] = useState<AnalysisStreamSnapshot | null>(null);
  const [copiedRawThinking, setCopiedRawThinking] = useState(false);
  const [isCaseSourceOpen, setIsCaseSourceOpen] = useState(false);

  const { data: analysis, isLoading } = useQuery<Analysis>({
    queryKey: ["/api/analyses", id],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/analyses/${id}`);
      return response.json();
    },
    refetchInterval: (query) => {
      const data = query.state.data as Analysis | undefined;
      if (!data || data.status === "pending" || data.status === "running") return 1500;
      return false;
    },
  });

  useEffect(() => {
    if (!analysis || (analysis.status !== "pending" && analysis.status !== "running")) {
      setStreamSnapshot(null);
      return;
    }

    const source = new EventSource(`/api/analyses/${id}/stream`);

    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as Partial<AnalysisStreamSnapshot>;
        const snapshot: AnalysisStreamSnapshot = {
          status: parsed.status || analysis.status,
          result: typeof parsed.result === "string" || parsed.result === null ? parsed.result : analysis.result,
          progress: parsed.progress || null,
        };

        setStreamSnapshot(snapshot);

        if (snapshot.status === "done" || snapshot.status === "error" || snapshot.status === "cancelled") {
          source.close();
        }
      } catch {
        // Ignore malformed SSE payloads and keep the latest good snapshot.
      }
    };

    source.onerror = () => {
      source.close();
    };

    return () => source.close();
  }, [analysis, id]);

  if (isLoading) return <LoadingSkeleton />;

  if (!analysis) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-16 text-center">
        <p className="text-muted-foreground">Анализ не найден</p>
        <Button variant="ghost" onClick={() => setLocation("/")} className="mt-4">
          <ArrowLeft className="w-4 h-4 mr-2" /> Назад
        </Button>
      </div>
    );
  }

  const liveAnalysis: Analysis = streamSnapshot
    ? {
        ...analysis,
        status: streamSnapshot.status,
        result: streamSnapshot.result,
      }
    : analysis;

  if (liveAnalysis.status === "pending" || liveAnalysis.status === "running") {
    return <RunningState analysis={liveAnalysis} progress={streamSnapshot?.progress || null} />;
  }

  if (liveAnalysis.status === "cancelled") {
    const stopMessage = parseErrorMessage(liveAnalysis) || streamSnapshot?.progress?.error || "Анализ был остановлен вручную.";

    return (
      <div className="max-w-4xl mx-auto px-6 py-16 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted/60">
          <PauseCircle className="h-6 w-6 text-muted-foreground" />
        </div>
        <p className="text-foreground font-medium">Анализ остановлен</p>
        <p className="text-muted-foreground mt-2 max-w-2xl mx-auto">{stopMessage}</p>
        <Button variant="ghost" onClick={() => setLocation("/history")} className="mt-4">
          <ArrowLeft className="w-4 h-4 mr-2" /> Вернуться в историю
        </Button>
      </div>
    );
  }

  if (liveAnalysis.status === "error") {
    const errorMessage = parseErrorMessage(liveAnalysis) || streamSnapshot?.progress?.error || "Модель не вернула пригодный результат анализа.";

    return (
      <div className="max-w-4xl mx-auto px-6 py-16 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>
        <p className="text-foreground font-medium">Анализ завершился ошибкой</p>
        <p className="text-muted-foreground mt-2 max-w-2xl mx-auto">{errorMessage}</p>
        <Button variant="ghost" onClick={() => setLocation("/")} className="mt-4">
          <ArrowLeft className="w-4 h-4 mr-2" /> Новый кейс
        </Button>
      </div>
    );
  }

  const result = parseResult(liveAnalysis);

  if (!result) {
    return <LoadingResultState />;
  }

  if (isIntegratedResult(result)) {
    return <IntegratedResultView analysis={liveAnalysis} result={result} />;
  }

  if (isComplexityResult(result)) {
    return <ComplexityResultView analysis={liveAnalysis} result={result} />;
  }

  const players = getDisplayPlayers(liveAnalysis, result);
  const playersById = new Map(players.map((player) => [player.id, player]));
  const pairwiseViews = getPairwiseViews(result);
  const confidence = getConfidence(result);
  const profilesCount = getProfilesCount(result, pairwiseViews);
  const assumptions = getUniqueAssumptions(result);
  const aggregatedActors = getUniqueAggregatedActors(result);

  const verdict = result.verdict as keyof typeof VERDICT_CONFIG;
  const verdictConfig = VERDICT_CONFIG[verdict] || VERDICT_CONFIG.revise;
  const VerdictIcon = verdictConfig.icon;
  const riskConfig = RISK_CONFIG[result.riskLevel as keyof typeof RISK_CONFIG] || RISK_CONFIG.medium;

  const barData = result.recommendedEquilibrium
    ? Object.entries(result.recommendedEquilibrium.payoffs).map(([playerId, value]) => ({
        name: playersById.get(playerId)?.name || playerId,
        value,
      }))
    : [];

  const defaultPairwise = pairwiseViews[0]?.players.join("__") || "empty";
  const rawThinking = result?.rawThinking ?? "";
  const decisionPack = result.decisionPack || null;

  async function handleCopyRawThinking() {
    if (!rawThinking) return;

    try {
      const copied = await copyText(rawThinking);

      if (!copied) {
        toast({
          title: "Не удалось скопировать текст",
          description: "Буфер обмена недоступен в этом браузере",
          variant: "destructive",
        });
        return;
      }

      setCopiedRawThinking(true);
      window.setTimeout(() => setCopiedRawThinking(false), 1600);
      toast({
        title: "Текст скопирован",
        description: "Развёрнутый вывод уже в буфере обмена",
      });
    } catch (error) {
      toast({
        title: "Не удалось скопировать текст",
        description: error instanceof Error ? error.message : "Попробуйте ещё раз",
        variant: "destructive",
      });
    }
  }

  function handleRestartWithAdjustedConditions() {
    saveAnalysisDraft({
      type: liveAnalysis.type,
      title: liveAnalysis.title,
      description: liveAnalysis.description,
      context: liveAnalysis.context,
    });
    setIsCaseSourceOpen(false);
    setLocation("/");
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8" data-testid="analysis-view">
      <Button variant="ghost" size="sm" onClick={() => setLocation("/history")} className="mb-6 -ml-2">
        <ArrowLeft className="w-4 h-4 mr-1.5" />
        История
      </Button>

      <div className="mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <Badge variant="outline" className="text-xs">
                {liveAnalysis.type === "strategy" ? "Стратегия" : "Фича"}
              </Badge>
              {result.gameType && (
                <Badge variant="secondary" className="text-xs">
                  {result.gameType}
                </Badge>
              )}
              <Badge variant="secondary" className="text-xs gap-1">
                <Users className="w-3 h-3" />
                {players.length} игроков
              </Badge>
              <Badge variant="secondary" className="text-xs gap-1">
                <Layers className="w-3 h-3" />
                {profilesCount} профилей
              </Badge>
            </div>
            <h1 className="text-xl font-bold text-foreground" data-testid="analysis-title">
              {liveAnalysis.title}
            </h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-3xl">
              {verdictConfig.desc}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-10 w-10 text-muted-foreground"
              onClick={() => setIsCaseSourceOpen(true)}
              title="Исходные данные кейса"
              aria-label="Исходные данные кейса"
            >
              <Settings2 className="w-4 h-4" />
            </Button>
            <div
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border font-bold text-sm ${verdictConfig.cls}`}
              data-testid="verdict-badge"
            >
              <VerdictIcon className="w-4 h-4" />
              {verdictConfig.label}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-4 flex flex-col items-center">
            <NashScoreGauge score={result.nashScore} />
            <p className="text-xs text-muted-foreground text-center mt-1">
              {result.nashScore >= 80
                ? "Отличная позиция Нэша"
                : result.nashScore >= 60
                  ? "Умеренно устойчиво"
                  : result.nashScore >= 40
                    ? "Нестабильное равновесие"
                    : "Позиция проигрывает лучшим ответам"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              Достоверность
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-foreground">{confidence}</div>
            <Progress value={confidence} className="h-2 mt-3" />
            <p className="text-xs text-muted-foreground mt-2">
              Проверки чувствительности:{" "}
              <span className="font-mono text-foreground">{result.sensitivityChecks?.length || 0}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Оценка полноты игровой модели и качества допущений по выигрышам.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5" />
              Риск и масштаб
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold font-mono ${riskConfig.cls}`} data-testid="risk-level">
              {riskConfig.label}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Равновесия Нэша:{" "}
              <span className="font-mono text-foreground">{result.equilibria.filter((item) => item.isNash).length}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Попарные срезы:{" "}
              <span className="font-mono text-foreground">{pairwiseViews.length}</span>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Target className="w-3.5 h-3.5" />
              Выигрыши
            </CardTitle>
          </CardHeader>
          <CardContent>
            {barData.length > 0 ? (
              <ResponsiveContainer width="100%" height={110}>
                <BarChart data={barData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: "hsl(220 10% 52%)" }} />
                  <YAxis
                    tick={{ fontSize: 10, fill: "hsl(220 10% 52%)", fontFamily: "JetBrains Mono" }}
                    domain={[-10, 10]}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(220 22% 11%)",
                      border: "1px solid hsl(220 15% 20%)",
                      borderRadius: 6,
                      fontSize: 11,
                    }}
                    labelStyle={{ color: "hsl(220 10% 85%)" }}
                    itemStyle={{ color: "hsl(38 92% 50%)" }}
                  />
                  <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                    {barData.map((entry, index) => (
                      <Cell key={index} fill={entry.value >= 0 ? "hsl(142 70% 45%)" : "hsl(0 70% 55%)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-xs text-muted-foreground">Нет данных по рекомендованному профилю</p>
            )}
          </CardContent>
        </Card>
      </div>

      {players.length > 0 && (
        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Users className="w-4 h-4 text-primary" />
              Состав игры
            </CardTitle>
            <CardDescription className="text-xs">
              Игроки и стратегии, которые агент использовал для расчёта многопользовательской модели.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {players.map((player) => (
              <div key={player.id} className="min-w-0 overflow-hidden rounded-lg border border-border/70 bg-muted/20 p-3">
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <div className="text-sm font-medium text-foreground">{player.name}</div>
                  <Badge variant="secondary" className="text-xs">{getPlayerTypeLabel(player.type)}</Badge>
                  {typeof player.weight === "number" && (
                  <Badge variant="outline" className="text-xs font-mono">
                      вес {player.weight}
                    </Badge>
                  )}
                </div>

                {player.incentives && (
                  <p className="text-xs text-muted-foreground mb-2 leading-relaxed">{player.incentives}</p>
                )}

                {player.strategies?.length > 0 && (
                  <div className="flex min-w-0 flex-wrap gap-1.5">
                    {player.strategies.map((strategy) => (
                      <Badge
                        key={strategy}
                        variant="secondary"
                        className="min-w-0 max-w-full whitespace-normal break-words text-left text-xs leading-relaxed"
                      >
                        {strategy}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {(aggregatedActors.length > 0 || assumptions.length > 0) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
          {aggregatedActors.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Layers className="w-4 h-4 text-primary" />
                  Сводные участники
                </CardTitle>
                <CardDescription className="text-xs">
                  Важные силы вокруг кейса, которые агент не включал в основную игру как отдельных игроков.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {aggregatedActors.map((actor) => (
                  <Badge key={actor} variant="outline" className="text-xs">
                    {actor}
                  </Badge>
                ))}
              </CardContent>
            </Card>
          )}

          {assumptions.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-primary" />
                  Допущения
                </CardTitle>
                <CardDescription className="text-xs">
                  Явные допущения, от которых зависит устойчивость результата.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {assumptions.map((assumption, index) => (
                    <div key={`${index}-${assumption}`} className="flex gap-2.5 text-sm">
                      <span className="text-primary font-mono text-xs mt-0.5">{index + 1}.</span>
                      <span className="text-foreground/85 leading-relaxed">{assumption}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Lightbulb className="w-4 h-4 text-primary" />
            Ключевые инсайты
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {result.keyInsights.map((insight, index) => (
              <div key={index} className="flex gap-3 text-sm" data-testid={`insight-${index}`}>
                <span className="text-primary font-mono font-bold shrink-0 text-xs mt-0.5">{index + 1}.</span>
                <span className="text-foreground/90 leading-relaxed">{insight}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Равновесия Нэша</CardTitle>
          <CardDescription className="text-xs">
            Профили, где ни один игрок не получает выгоду от одностороннего отклонения.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EquilibriaList result={result} playersById={playersById} />
        </CardContent>
      </Card>

      {pairwiseViews.length > 0 && (
        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Попарные срезы</CardTitle>
            <CardDescription className="text-xs">
              Двумерные срезы основной многопользовательской игры. Остальные игроки зафиксированы по рекомендованному профилю.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue={defaultPairwise}>
              <TabsList className="h-auto flex-wrap justify-start">
                {pairwiseViews.map((view) => {
                  const key = view.players.join("__");
                  const left = playersById.get(view.players[0])?.name || view.players[0];
                  const right = playersById.get(view.players[1])?.name || view.players[1];

                  return (
                    <TabsTrigger key={key} value={key} className="text-xs">
                      {left} / {right}
                    </TabsTrigger>
                  );
                })}
              </TabsList>

              {pairwiseViews.map((view) => {
                const key = view.players.join("__");
                return (
                  <TabsContent key={key} value={key}>
                    <PairwiseMatrix view={view} playersById={playersById} />
                  </TabsContent>
                );
              })}
            </Tabs>
          </CardContent>
        </Card>
      )}

      {result.sensitivityChecks?.length > 0 && (
        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              Проверки чувствительности
            </CardTitle>
            <CardDescription className="text-xs">
              Что может поменять вывод, если в игре появятся дополнительные значимые акторы или новые факторы.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {result.sensitivityChecks.map((check, index) => (
              <div key={`${check.omittedPlayerId}-${index}`} className="p-3 rounded-lg border border-border/70 bg-muted/30">
                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                  <Badge variant="outline" className="text-xs font-mono">
                    {check.omittedPlayerId}
                  </Badge>
                  <span className={`text-xs font-medium ${RISK_CONFIG[check.impact as keyof typeof RISK_CONFIG]?.cls || ""}`}>
                    {RISK_CONFIG[check.impact as keyof typeof RISK_CONFIG]?.label || check.impact}
                  </span>
                </div>
                <p className="text-sm text-foreground/85 leading-relaxed">{check.note}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            Рекомендации
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2.5">
            {result.recommendations.map((recommendation, index) => (
              <div key={index} className="flex gap-2.5 p-2.5 rounded-lg bg-muted/50" data-testid={`recommendation-${index}`}>
                <ChevronRight className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                <span className="text-sm text-foreground/90 leading-relaxed">{recommendation}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {result.breakEquilibriumMoves?.length > 0 && (
        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-yellow-500" />
              Угрозы нарушения равновесия
            </CardTitle>
            <CardDescription className="text-xs">
              Контрходы и внешние изменения, которые могут разрушить рекомендованный профиль.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {result.breakEquilibriumMoves.map((move, index) => (
                <div key={index} className="flex gap-2.5 text-sm" data-testid={`break-move-${index}`}>
                  <span className="text-yellow-500/80 shrink-0">⚠</span>
                  <span className="text-foreground/80 leading-relaxed">{move}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {rawThinking && (
        <Card className="mb-4">
          <CardHeader className="pb-3 flex-row items-center justify-between space-y-0 gap-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Brain className="w-4 h-4 text-muted-foreground" />
              Развёрнутый анализ агента
            </CardTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              onClick={handleCopyRawThinking}
              title={copiedRawThinking ? "Скопировано" : "Скопировать итоговый вывод"}
              aria-label={copiedRawThinking ? "Скопировано" : "Скопировать итоговый вывод"}
            >
              {copiedRawThinking ? <CheckCircle2 className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
            </Button>
          </CardHeader>
          <CardContent>
            <div
              className="w-full rounded-lg bg-muted/30 px-5 py-4 text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap break-words"
              data-testid="raw-thinking"
            >
              {rawThinking}
            </div>
          </CardContent>
        </Card>
      )}

      {decisionPack ? (
        <DecisionPackSection decisionPack={decisionPack} playersById={playersById} />
      ) : null}

      <div className="mt-8 flex justify-center">
        <Button asChild variant="outline" className="gap-2">
          <a href={`/api/analyses/${liveAnalysis.id}/pdf`} download data-testid="download-analysis-pdf">
            <FileDown className="w-4 h-4" />
            Скачать PDF-документ
          </a>
        </Button>
      </div>

      <Dialog open={isCaseSourceOpen} onOpenChange={setIsCaseSourceOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Исходные данные кейса</DialogTitle>
            <DialogDescription>
              Здесь можно посмотреть исходные поля текущего кейса и перенести их в новый анализ для правок.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Название</div>
              <div className="rounded-lg border border-border/70 bg-muted/30 px-4 py-3 text-sm text-foreground">
                {liveAnalysis.title || "Без названия"}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Описание</div>
              <ScrollArea className="h-48 rounded-lg border border-border/70 bg-muted/30">
                <div className="px-4 py-3 text-sm leading-relaxed text-foreground whitespace-pre-wrap">
                  {liveAnalysis.description || "Не заполнено"}
                </div>
              </ScrollArea>
            </div>

            <div className="space-y-1.5">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Контекст</div>
              <ScrollArea className="h-40 rounded-lg border border-border/70 bg-muted/30">
                <div className="px-4 py-3 text-sm leading-relaxed text-foreground whitespace-pre-wrap">
                  {liveAnalysis.context || "Не заполнено"}
                </div>
              </ScrollArea>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setIsCaseSourceOpen(false)}>
              Закрыть
            </Button>
            <Button type="button" onClick={handleRestartWithAdjustedConditions}>
              Поменять условия анализа
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
