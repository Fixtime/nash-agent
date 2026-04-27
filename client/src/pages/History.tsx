import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import type { Analysis, AnalysisResult, Player } from "@/lib/analysis-types";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Layers,
  Loader2,
  PauseCircle,
  Plus,
  Sparkles,
  Square,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";

function isAnalysisResult(value: unknown): value is AnalysisResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AnalysisResult).nashScore === "number" &&
    Array.isArray((value as AnalysisResult).equilibria)
  );
}

function parseResult(analysis: Analysis): AnalysisResult | null {
  if (!analysis.result) return null;
  try {
    const parsed = JSON.parse(analysis.result) as unknown;
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

function getDisplayPlayers(analysis: Analysis, result: AnalysisResult | null) {
  if (result?.playersUsed?.length) {
    return result.playersUsed;
  }

  return parseSubmittedPlayers(analysis);
}

const VERDICT_CONFIG = {
  launch: { label: "Запускать", icon: CheckCircle2, cls: "verdict-launch" },
  revise: { label: "Доработать", icon: AlertTriangle, cls: "verdict-revise" },
  pause: { label: "Пауза", icon: PauseCircle, cls: "verdict-pause" },
  kill: { label: "Отменить", icon: XCircle, cls: "verdict-kill" },
} as const;

function StatusBadge({ status }: { status: string }) {
  if (status === "done") return null;

  if (status === "running" || status === "pending") {
    return (
      <Badge variant="secondary" className="text-xs gap-1">
        <Loader2 className="w-2.5 h-2.5 animate-spin" />
        {status === "running" ? "Анализ..." : "В очереди"}
      </Badge>
    );
  }

  if (status === "error") {
    return (
      <Badge variant="destructive" className="text-xs">
        Ошибка
      </Badge>
    );
  }

  if (status === "cancelled") {
    return (
      <Badge variant="outline" className="text-xs gap-1">
        <Square className="w-2.5 h-2.5" />
        Остановлен
      </Badge>
    );
  }

  return null;
}

function NashScoreBar({ score }: { score: number }) {
  function getColor() {
    if (score >= 80) return "bg-emerald-500";
    if (score >= 60) return "bg-amber-500";
    if (score >= 40) return "bg-orange-500";
    return "bg-red-500";
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${getColor()}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-mono text-foreground w-6 text-right">{score}</span>
    </div>
  );
}

function formatDate(timestamp: number | string | null | undefined) {
  if (!timestamp) return "—";
  try {
    const date =
      typeof timestamp === "number"
        ? new Date(timestamp > 1e10 ? timestamp : timestamp * 1000)
        : new Date(timestamp);
    if (isNaN(date.getTime())) return "—";
    return date.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function formatDuration(ms: number | null | undefined) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;

  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}ч ${minutes}м`;
  if (minutes > 0) return `${minutes}м ${seconds}с`;
  return `${seconds}с`;
}

function AnalysisCard({
  analysis,
  onStop,
  isStopping,
  onDelete,
  isDeleting,
}: {
  analysis: Analysis;
  onStop: (id: number) => void;
  isStopping: boolean;
  onDelete: (analysis: Analysis) => void;
  isDeleting: boolean;
}) {
  const [, setLocation] = useLocation();
  const result = parseResult(analysis);
  const players = getDisplayPlayers(analysis, result);
  const verdict = result?.verdict as keyof typeof VERDICT_CONFIG | undefined;
  const verdictConfig = verdict ? VERDICT_CONFIG[verdict] : null;
  const VerdictIcon = verdictConfig?.icon;
  const profilesCount = result?.profiles?.length || result?.equilibria?.length || 0;
  const confidence = typeof result?.confidence === "number" ? Math.round(result.confidence) : null;
  const runtimeDuration = formatDuration(result?.runtimeStats?.durationMs);
  const runtimeChunks = typeof result?.runtimeStats?.chunks === "number" ? result.runtimeStats.chunks : null;
  const canStop = analysis.status === "pending" || analysis.status === "running";
  const canDelete = !canStop;

  return (
    <Card
      className="cursor-pointer hover-elevate transition-all"
      onClick={() => setLocation(`/analysis/${analysis.id}`)}
      data-testid={`analysis-card-${analysis.id}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <Badge variant="outline" className="text-xs shrink-0">
                {analysis.type === "strategy" ? "Стратегия" : "Фича"}
              </Badge>
              <StatusBadge status={analysis.status} />
              {verdictConfig && (
                <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${verdictConfig.cls}`}>
                  {VerdictIcon && <VerdictIcon className="w-3 h-3" />}
                  {verdictConfig.label}
                </span>
              )}
            </div>

            <h3 className="text-sm font-semibold text-foreground truncate mb-1" data-testid="analysis-name">
              {analysis.title}
            </h3>

            {(players.length > 0 || profilesCount > 0 || confidence !== null || runtimeDuration || runtimeChunks !== null) && (
              <div className="flex items-center gap-2 flex-wrap mb-2">
                {players.length > 0 && (
                  <Badge variant="secondary" className="text-xs gap-1">
                    <Users className="w-3 h-3" />
                    {players.length} игроков
                  </Badge>
                )}
                {profilesCount > 0 && (
                  <Badge variant="secondary" className="text-xs gap-1">
                    <Layers className="w-3 h-3" />
                    {profilesCount} профилей
                  </Badge>
                )}
                {confidence !== null && (
                  <Badge variant="secondary" className="text-xs gap-1">
                    <Sparkles className="w-3 h-3" />
                    достов. {confidence}
                  </Badge>
                )}
                {runtimeDuration && (
                  <Badge variant="secondary" className="text-xs gap-1">
                    <Clock className="w-3 h-3" />
                    {runtimeDuration}
                  </Badge>
                )}
                {runtimeChunks !== null && (
                  <Badge variant="secondary" className="text-xs font-mono">
                    {runtimeChunks} фрагм.
                  </Badge>
                )}
              </div>
            )}

            {players.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {players.slice(0, 4).map((player) => (
                  <span key={player.id} className="text-xs text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
                    {player.name}
                  </span>
                ))}
                {players.length > 4 && (
                  <span className="text-xs text-muted-foreground">+{players.length - 4}</span>
                )}
              </div>
            )}

            {result && (
              <div className="mt-2">
                <NashScoreBar score={result.nashScore} />
              </div>
            )}

            <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground">
              <Clock className="w-3 h-3" />
              {formatDate(analysis.createdAt as number | string | null | undefined)}
            </div>
          </div>

          <div className="flex items-start gap-2 shrink-0 mt-0.5">
            {canStop && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-3"
                disabled={isStopping}
                onClick={(event) => {
                  event.stopPropagation();
                  onStop(analysis.id);
                }}
                data-testid={`analysis-stop-${analysis.id}`}
              >
                <Square className="w-3.5 h-3.5 mr-1.5" />
                {isStopping ? "Останавливаем..." : "Стоп"}
              </Button>
            )}
            {canDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2.5 text-muted-foreground hover:text-destructive"
                disabled={isDeleting}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(analysis);
                }}
                data-testid={`analysis-delete-${analysis.id}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 mt-1" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function History() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const stopMutation = useMutation<Analysis, Error, number, { previous?: Analysis[] }>({
    mutationFn: async (id) => {
      const response = await apiRequest("POST", `/api/analyses/${id}/stop`);
      return response.json();
    },
    onMutate: async (id) => {
      const previous = queryClient.getQueryData<Analysis[]>(["/api/analyses"]);
      queryClient.setQueryData<Analysis[]>(["/api/analyses"], (current) =>
        current?.map((analysis) =>
          analysis.id === id
            ? {
                ...analysis,
                status: "cancelled",
                result: JSON.stringify({ error: "Анализ остановлен пользователем", cancelled: true }),
              }
            : analysis
        ) ?? current
      );

      return { previous };
    },
    onError: (error, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["/api/analyses"], context.previous);
      }

      toast({
        title: "Не удалось остановить анализ",
        description: error.message || "Попробуйте ещё раз",
        variant: "destructive",
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<Analysis[]>(["/api/analyses"], (current) =>
        current?.map((analysis) => (analysis.id === updated.id ? updated : analysis)) ?? current
      );
      queryClient.setQueryData(["/api/analyses", updated.id], updated);
    },
    onSettled: (_data, _error, id) => {
      queryClient.invalidateQueries({ queryKey: ["/api/analyses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/analyses", id] });
    },
  });

  const deleteMutation = useMutation<Analysis, Error, number, { previous?: Analysis[] }>({
    mutationFn: async (id) => {
      const response = await apiRequest("POST", `/api/analyses/${id}/delete`);
      return response.json();
    },
    onMutate: async (id) => {
      const previous = queryClient.getQueryData<Analysis[]>(["/api/analyses"]);
      queryClient.setQueryData<Analysis[]>(["/api/analyses"], (current) =>
        current?.filter((analysis) => analysis.id !== id) ?? current
      );

      return { previous };
    },
    onError: (error, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["/api/analyses"], context.previous);
      }

      toast({
        title: "Не удалось удалить кейс",
        description: error.message || "Попробуйте ещё раз",
        variant: "destructive",
      });
    },
    onSuccess: (deleted) => {
      queryClient.removeQueries({ queryKey: ["/api/analyses", deleted.id] });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/analyses"] });
    },
  });

  const { data: analyses, isLoading } = useQuery<Analysis[]>({
    queryKey: ["/api/analyses"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/analyses");
      return response.json();
    },
    refetchInterval: (query) => {
      const items = query.state.data as Analysis[] | undefined;
      if (items?.some((analysis) => analysis.status === "pending" || analysis.status === "running")) return 2000;
      return false;
    },
  });

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xl font-bold text-foreground">История игр</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {analyses?.length
              ? `${analyses.length} ${analyses.length === 1 ? "анализ" : "анализов"}`
              : "Все проведённые анализы Нэша"}
          </p>
        </div>
        <Button onClick={() => setLocation("/")} data-testid="btn-new-analysis">
          <Plus className="w-4 h-4 mr-1.5" />
          Новый кейс
        </Button>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((value) => (
            <Skeleton key={value} className="h-28 w-full" />
          ))}
        </div>
      )}

      {!isLoading && (!analyses || analyses.length === 0) && (
        <Card className="border-dashed">
          <CardContent className="py-16 text-center">
            <Clock className="w-10 h-10 text-muted-foreground mx-auto mb-4" />
            <p className="text-sm font-medium text-foreground">История пуста</p>
            <p className="text-xs text-muted-foreground mt-1.5">
              Опишите первый кейс, и агент сам соберёт игроков, стратегии и модель равновесия Нэша.
            </p>
            <Button onClick={() => setLocation("/")} className="mt-6" data-testid="btn-first-analysis">
              <Plus className="w-4 h-4 mr-1.5" />
              Создать первый кейс
            </Button>
          </CardContent>
        </Card>
      )}

      {!isLoading && analyses && analyses.length > 0 && (
        <div className="space-y-3" data-testid="analyses-list">
          {[...analyses].reverse().map((analysis) => (
            <AnalysisCard
              key={analysis.id}
              analysis={analysis}
              onStop={(id) => stopMutation.mutate(id)}
              isStopping={stopMutation.isPending && stopMutation.variables === analysis.id}
              onDelete={(item) => {
                if (window.confirm(`Удалить кейс «${item.title}» из истории? Это действие нельзя отменить.`)) {
                  deleteMutation.mutate(item.id);
                }
              }}
              isDeleting={deleteMutation.isPending && deleteMutation.variables === analysis.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
