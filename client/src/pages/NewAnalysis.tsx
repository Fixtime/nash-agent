import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { consumeAnalysisDraft } from "@/lib/analysis-draft";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import type { AnalysisLiveProgress, AnalysisStreamSnapshot, AnalysisType } from "@/lib/analysis-types";
import {
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  Layers,
  Settings2,
  Sparkles,
  Users,
  Zap,
} from "lucide-react";

interface FormState {
  type: AnalysisType;
  title: string;
  description: string;
  context: string;
}

const STEPS = [
  { label: "Кейс", icon: Layers },
  { label: "Контекст", icon: Settings2 },
  { label: "Запуск", icon: Zap },
];

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-0">
      {STEPS.map((step, index) => {
        const Icon = step.icon;
        const isDone = index < current;
        const isActive = index === current;
        const cls = isDone ? "step-done" : isActive ? "step-active" : "step-idle";

        return (
          <div key={step.label} className="flex items-center">
            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-all ${cls}`}>
              {isDone ? <Check className="w-3 h-3" /> : <Icon className="w-3 h-3" />}
              {step.label}
            </div>
            {index < STEPS.length - 1 && (
              <div className={`w-6 h-px mx-1 transition-colors ${isDone ? "bg-primary/50" : "bg-border"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function StepCase({
  form,
  setForm,
}: {
  form: FormState;
  setForm: (form: FormState) => void;
}) {
  const descriptionLength = form.description.trim().length;

  return (
    <div className="space-y-5">
      <div>
        <Label className="text-sm font-medium mb-2 block">Тип объекта анализа</Label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            {
              value: "strategy" as const,
              label: "Продуктовая стратегия",
              desc: "Полное решение по продукту, рынку, запуску и ответу конкурентов.",
            },
            {
              value: "feature" as const,
              label: "Фича",
              desc: "Отдельная функциональность перед передачей в разработку или запуском.",
            },
          ].map(({ value, label, desc }) => (
            <button
              key={value}
              type="button"
              data-testid={`type-${value}`}
              onClick={() => setForm({ ...form, type: value })}
              className={`text-left p-4 rounded-lg border transition-all hover-elevate ${
                form.type === value
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-card text-muted-foreground"
              }`}
            >
              <div className="text-sm font-medium mb-1 text-foreground">{label}</div>
              <div className="text-xs text-muted-foreground">{desc}</div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <Label htmlFor="title" className="text-sm font-medium mb-2 block">
          Название
        </Label>
        <Input
          id="title"
          data-testid="input-title"
          value={form.title}
          onChange={(event) => setForm({ ...form, title: event.target.value })}
          placeholder="Если оставить пустым, агент сформулирует название сам"
          className="bg-muted/50"
        />
      </div>

      <div>
        <div className="flex items-center justify-between gap-3 mb-2">
          <Label htmlFor="description" className="text-sm font-medium">
            Описание кейса <span className="text-destructive">*</span>
          </Label>
          <span className="text-xs text-muted-foreground font-mono">{descriptionLength} симв.</span>
        </div>
        <Textarea
          id="description"
          data-testid="input-description"
          value={form.description}
          onChange={(event) => setForm({ ...form, description: event.target.value })}
          placeholder={`Опишите кейс так, как будто его будет читать сильный продакт-стратег:

Что вы хотите запустить
Для какого сегмента и рынка
Почему сейчас
Какая ценность для пользователя
Какие ограничения по времени, бюджету, платформам или регуляторике
Какие реакции конкурентов или партнёров вас беспокоят`}
          rows={10}
          className="bg-muted/50 resize-none leading-relaxed"
        />
        <p className="text-xs text-muted-foreground mt-2">
          Ручной ввод игроков больше не обязателен. Агент сам выделит 3-5 ключевых участников, предложит их стратегии и построит игровую модель.
        </p>
      </div>

      <Card className="border-primary/20 bg-primary/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            Что агент сделает автоматически
          </CardTitle>
          <CardDescription className="text-xs">
            После запуска сервер сам соберёт компактную многопользовательскую игру под ваш кейс.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div className="rounded-lg border border-border/60 bg-card/60 p-3">
            <div className="text-xs font-medium text-foreground mb-1">Игроки</div>
            <div className="text-xs text-muted-foreground">Выделит ключевых участников: команда, конкуренты, платформа, регулятор, спрос.</div>
          </div>
          <div className="rounded-lg border border-border/60 bg-card/60 p-3">
            <div className="text-xs font-medium text-foreground mb-1">Стратегии</div>
            <div className="text-xs text-muted-foreground">Сгенерирует 2-3 релевантных стратегии на игрока.</div>
          </div>
          <div className="rounded-lg border border-border/60 bg-card/60 p-3">
            <div className="text-xs font-medium text-foreground mb-1">Профили игры</div>
            <div className="text-xs text-muted-foreground">Построит и оценит до 64 стратегических профилей, затем найдёт устойчивые равновесия.</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StepContext({
  form,
  setForm,
}: {
  form: FormState;
  setForm: (form: FormState) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <Label htmlFor="context" className="text-sm font-medium mb-2 block">
          Дополнительный контекст
        </Label>
        <Textarea
          id="context"
          data-testid="input-context"
          value={form.context}
          onChange={(event) => setForm({ ...form, context: event.target.value })}
          placeholder={`Добавьте всё, что может изменить наилучший ответ игроков:

• временной горизонт и окно запуска
• текущая позиция на рынке
• каналы дистрибуции и платформенные зависимости
• риски копирования
• регуляторные ограничения
• бюджет, ресурсы, команда
• данные, устойчивые преимущества, партнёры
• известные сигналы о конкурентах`}
          rows={10}
          className="bg-muted/50 resize-none font-mono text-xs leading-relaxed"
        />
        <p className="text-xs text-muted-foreground mt-2">
          Это поле опционально, но именно оно сильнее всего повышает качество сгенерированных игроков, стратегий и допущений по выигрышам.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Сводка перед запуском
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-3">
            <span className="text-xs text-muted-foreground w-24 shrink-0">Тип</span>
            <Badge variant="secondary" className="text-xs">
              {form.type === "strategy" ? "Стратегия" : "Фича"}
            </Badge>
          </div>
          <div className="flex gap-3">
            <span className="text-xs text-muted-foreground w-24 shrink-0">Название</span>
            <span className="text-xs text-foreground font-medium">{form.title.trim() || "Сгенерирует агент"}</span>
          </div>
          <div className="flex gap-3">
            <span className="text-xs text-muted-foreground w-24 shrink-0">Игроки</span>
            <span className="text-xs text-foreground">Будут выведены автоматически из кейса</span>
          </div>
          <div className="flex gap-3">
            <span className="text-xs text-muted-foreground w-24 shrink-0">Модель</span>
            <span className="text-xs text-foreground font-mono">3-5 ключевых игроков · до 64 профилей</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StepRunning({
  analysisId,
  progress,
}: {
  analysisId: number | null;
  progress: AnalysisLiveProgress | null;
}) {
  const livePreview = progress?.previewText?.trim() || "";

  return (
    <div className="flex flex-col items-center justify-center py-12 space-y-6">
      <div className="relative w-16 h-16">
        <div className="absolute inset-0 rounded-full border-2 border-border" />
        <div className="absolute inset-0 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        <div className="absolute inset-3 rounded-full bg-primary/10 flex items-center justify-center">
          <Brain className="w-5 h-5 text-primary" />
        </div>
      </div>

      <div className="text-center">
        <p className="text-sm font-medium text-foreground">Агент Нэша моделирует игру...</p>
        <p className="text-xs text-muted-foreground mt-1">
          {progress?.llmStatus || "Генерация игроков, стратегий, профилей выигрышей и равновесий Нэша"}
        </p>
        {analysisId && (
          <p className="text-xs text-muted-foreground/60 mt-1 font-mono">Номер анализа: #{analysisId}</p>
        )}
      </div>

      <div className="space-y-2 w-full max-w-xs">
        {[
          "Выделение релевантных игроков",
          "Генерация стратегий и допущений",
          "Оценка стратегических профилей",
          "Поиск равновесий Нэша",
          "Формирование вердикта и рекомендаций",
        ].map((item, index) => (
          <div key={item} className="flex items-center gap-2.5 text-xs text-muted-foreground">
            <div
              className="w-1.5 h-1.5 rounded-full bg-primary/40 shrink-0 animate-pulse"
              style={{ animationDelay: `${index * 0.3}s` }}
            />
            {item}
          </div>
        ))}
      </div>

      <div className="w-full max-w-2xl rounded-xl border border-border/70 bg-muted/20 p-4">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Поток ответа модели</p>
            <p className="text-sm font-medium text-foreground mt-1">
              {progress?.phaseLabel || "Ждём первые токены от модели"}
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {progress?.chunks ? (
              <Badge variant="secondary" className="text-xs font-mono">
                {progress.chunks} фрагм.
              </Badge>
            ) : null}
            {progress?.error ? (
              <Badge variant="destructive" className="text-xs">
                Ошибка
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs">
                {livePreview ? "Поток идёт" : "Пока без токенов"}
              </Badge>
            )}
          </div>
        </div>

        <ScrollArea className="h-56 rounded-lg border border-border/60 bg-background/60 p-3">
          {livePreview ? (
            <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground font-mono">
              {livePreview}
            </pre>
          ) : (
            <div className="flex h-full min-h-40 items-center justify-center text-center text-xs text-muted-foreground">
              Как только модель начнёт отвечать, здесь появится текущий поток её текста до итогового JSON.
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

export default function NewAnalysis() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [liveProgress, setLiveProgress] = useState<AnalysisLiveProgress | null>(null);

  const [form, setForm] = useState<FormState>({
    type: "feature",
    title: "",
    description: "",
    context: "",
  });

  useEffect(() => {
    const draft = consumeAnalysisDraft();
    if (!draft) return;

    setForm({
      type: draft.type,
      title: draft.title,
      description: draft.description,
      context: draft.context,
    });
    setStep(0);
    setCreatedId(null);
    setLiveProgress(null);
    toast({
      title: "Условия перенесены",
      description: "Отредактируйте кейс и запустите новый анализ",
    });
  }, [toast]);

  const createMutation = useMutation({
    mutationFn: async (data: FormState) => {
      const payload = {
        type: data.type,
        title: data.title.trim(),
        description: data.description,
        players: [],
        context: data.context,
      };
      const response = await apiRequest("POST", "/api/analyses", payload);
      return response.json();
    },
    onSuccess: async (analysis: { id: number }) => {
      setLiveProgress(null);
      setCreatedId(analysis.id);
      setStep(2);
      pollForResult(analysis.id);
    },
    onError: (error: Error) => {
      setLiveProgress(null);
      toast({
        title: "Ошибка создания анализа",
        description: error.message || "Попробуйте ещё раз",
        variant: "destructive",
      });
    },
  });

  async function pollForResult(id: number) {
    try {
      const eventSource = new EventSource(
        (window as { __PORT_5000__?: string }).__PORT_5000__
          ? `${(window as { __PORT_5000__?: string }).__PORT_5000__}/api/analyses/${id}/stream`
          : `/api/analyses/${id}/stream`
      );

      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data) as Partial<AnalysisStreamSnapshot>;
        setLiveProgress(data.progress || null);

        if (data.status === "done" || data.status === "error" || data.status === "cancelled") {
          eventSource.close();
          setTimeout(() => setLocation(`/analysis/${id}`), 600);
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
        setTimeout(() => setLocation(`/analysis/${id}`), 3000);
      };
    } catch {
      setTimeout(() => setLocation(`/analysis/${id}`), 3000);
    }
  }

  function validateStep(currentStep: number): string | null {
    if (currentStep === 0) {
      if (form.description.trim().length < 40) {
        return "Опишите кейс чуть подробнее, чтобы агент смог выделить релевантных игроков и стратегии";
      }
    }

    return null;
  }

  function handleNext() {
    const error = validateStep(step);
    if (error) {
      toast({
        title: "Нужно больше контекста",
        description: error,
        variant: "destructive",
      });
      return;
    }

    if (step === 1) {
      setLiveProgress(null);
      createMutation.mutate(form);
      return;
    }

    setStep((value) => value + 1);
  }

  const stepComponents = [
    <StepCase key="case" form={form} setForm={setForm} />,
    <StepContext key="context" form={form} setForm={setForm} />,
    <StepRunning key="running" analysisId={createdId} progress={liveProgress} />,
  ];

  const stepTitles = [
    "Опишите кейс",
    "Контекст и ограничения",
    "Анализ запущен",
  ];

  const stepDescriptions = [
    "Дайте агенту качественное описание стратегии или фичи. Игроков и стратегии он соберёт сам.",
    "Добавьте факторы, которые меняют лучшие ответы игроков и устойчивость равновесия.",
    "Агент строит компактную многопользовательскую игровую модель и готовит рекомендации.",
  ];

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-xl font-bold text-foreground mb-1">Агент Нэша</h1>
        <p className="text-sm text-muted-foreground">
          Опишите продуктовый кейс, а агент сам смоделирует игроков, стратегии и устойчивость запуска.
        </p>
      </div>

      <div className="mb-8 overflow-x-auto pb-1">
        <StepIndicator current={step} />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base font-semibold">{stepTitles[step]}</CardTitle>
          <CardDescription className="text-sm">{stepDescriptions[step]}</CardDescription>
        </CardHeader>
        <CardContent>{stepComponents[step]}</CardContent>
      </Card>

      {step < 2 && (
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={() => setStep((value) => value - 1)}
            disabled={step === 0}
            data-testid="btn-prev"
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            Назад
          </Button>

          <Button
            onClick={handleNext}
            disabled={createMutation.isPending}
            data-testid="btn-next"
          >
            {step === 1 ? (
              createMutation.isPending ? (
                "Запуск..."
              ) : (
                <>
                  <Zap className="w-4 h-4 mr-1.5" />
                  Запустить анализ
                </>
              )
            ) : (
              <>
                Далее
                <ChevronRight className="w-4 h-4 ml-1" />
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
