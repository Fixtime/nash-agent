import type { Express, Request, Response } from "express";
import type { Server } from "http";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import PDFDocument from "pdfkit";
import {
  type Analysis,
  type AnalysisMode,
  insertAnalysisSchema,
  type AnalysisResult,
  type ComplexityAnalysisResult,
  type IntegratedAnalysisResult,
  type CounterMovePlaybookItem,
  type DecisionPack,
  type DeviationCheck,
  type ExperimentPlanItem,
  type NashScenario,
  type PairwiseView,
  type PayoffCell,
  type Player,
  type ProductDecision,
  type SensitivityCheck,
  type StrategicMove,
  type StrategyProfile,
} from "@shared/schema";
import {
  COMPLEXITY_ARTICLE_SYSTEM_PROMPT,
  COMPLEXITY_DECISION_SYSTEM_PROMPT,
  COMPLEXITY_SETUP_SYSTEM_PROMPT,
  assertComplexityGuardrails,
  composeComplexityResult,
  normalizeComplexityDecision,
  normalizeComplexitySetup,
  simulateComplexitySystem,
  type ComplexityArticleResponse,
  type ComplexityDecisionResponse,
  type ComplexitySetupResponse,
  type NormalizedComplexitySetup,
} from "./complexity";
import { storage } from "./storage";

const MAX_CORE_PLAYERS = 5;
const MAX_PROFILE_BUDGET = 64;
const DEFAULT_PROFILE_BATCH_SIZE = 4;
const SETTINGS_FILE_PATH = path.join(process.cwd(), ".nash-agent-settings.json");
const PDF_FONT_REGULAR_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial Unicode.ttf",
  "/Library/Fonts/Arial.ttf",
];
const PDF_FONT_BOLD_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
];
const PDF_FOOTER_RESERVED_HEIGHT = 28;

type LlmProvider = "local" | "yandex";

interface ProviderSettings {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens?: number;
  temperature?: number;
  projectId?: string;
}

interface AppSettings {
  llmProvider: LlmProvider;
  local: ProviderSettings;
  yandex: ProviderSettings;
}

interface PublicProviderSettings extends Omit<ProviderSettings, "apiKey"> {
  apiKeySet: boolean;
}

interface PublicAppSettings {
  llmProvider: LlmProvider;
  local: PublicProviderSettings;
  yandex: PublicProviderSettings;
}

const RUSSIAN_JSON_CONTRACT = `ЯЗЫКОВОЕ ПРАВИЛО ДЛЯ JSON:
- Все человекочитаемые строковые значения JSON должны быть на русском языке.
- Это относится к names, incentives, strategies, aggregatedActors, assumptions, caseFrame, summary, gameType, keyInsights, recommendations, rawThinking, метрикам, критериям, guardrails, playbook и открытым вопросам.
- JSON-ключи и технические идентификаторы оставляй как в схеме: p1, p2, profile_1, launch, revise, pause, kill, low, medium, high, S, M, L.
- Допустимы только технические сокращения вроде API, SLA, UX, UI, JSON, LLM, PM, A/B, GMV, LTV.
- Если входные данные или акторы на английском, переведи их на русский или транслитерируй: Buyers -> Покупатели, Sellers -> Продавцы, Admins -> Администраторы, Competing marketplaces -> Конкурирующие маркетплейсы.
- Не используй английские предложения, английские названия сегментов или гибриды вроде "Buyer disengagement", "Support ticket volume", "Optimal equilibrium".`;

const SETUP_SYSTEM_PROMPT = `Ты — Strategic Game Designer для Nash Agent.

Твоя задача: по описанию продуктового кейса собрать компактную, но реалистичную n-player игру, которую потом можно анализировать через Nash Equilibrium.

ПРАВИЛА:
- Первый игрок всегда должен быть фокальным актором: команда/компания, которая рассматривает запуск стратегии или фичи.
- Выделяй 3-5 ключевых игроков, которые реально могут изменить outcome.
- Для каждого игрока дай 2 стратегии по умолчанию; максимум у одного игрока может быть 3 стратегии.
- Общая сложность игры должна оставаться управляемой: суммарное число strategy profiles не больше 64.
- Если пользователь прислал своих игроков, используй их как подсказку, но смело объединяй, переименовывай и отбрасывай нерелевантных.
- Не включай декоративных акторов, которые не меняют лучшие ответы других игроков.
- Дополнительно перечисли агрегированных акторов, которых полезно держать в уме, но не стоит включать в core game.

Верни строго JSON:
{
  "players": [
    {
      "name": "string",
      "type": "competitor|partner|regulator|user|platform|other",
      "incentives": "string",
      "strategies": ["string", "string"],
      "weight": 1-5
    }
  ],
  "aggregatedActors": ["string"],
  "assumptions": ["string"],
  "caseFrame": "краткий фрейм игры"
}`;

const PAYOFF_SYSTEM_PROMPT = `Ты — Nash Equilibrium Analyst для продуктовых решений.

Твоя задача: на основе уже выбранных игроков и списка strategy profiles оценить payoffs для каждого профиля и дать продуктовую интерпретацию.

ПРАВИЛА:
- Оценивай payoffs в диапазоне от -10 до 10.
- Каждый payoff отражает рациональный интерес конкретного игрока, а не "справедливость".
- Смотри на горизонт 6-12 месяцев, если не указано иное.
- Учитывай скорость реакции конкурентов, регуляторику, распределение контроля над дистрибуцией и вероятность копирования.
- Не придумывай новые profiles — оцени только те, которые переданы в запросе.
- Для каждого profile верни payoff каждого playerId.
- Верни confidence как оценку того, насколько модель игроков и payoff-структура устойчива к скрытым факторам.

Верни строго JSON:
{
  "profiles": [
    {
      "id": "profile_1",
      "payoffs": {"p1": 0, "p2": 0},
      "feasible": true,
      "summary": "краткое объяснение профиля"
    }
  ],
  "gameType": "string",
  "keyInsights": ["string", "string", "string"],
  "breakEquilibriumMoves": ["string", "string"],
  "recommendations": ["string", "string", "string"],
  "sensitivityChecks": [
    {
      "omittedPlayerId": "string",
      "impact": "low|medium|high",
      "note": "string"
    }
  ],
  "confidence": 0-100,
  "rawThinking": "развёрнутый анализ на русском языке"
}`;

const PAYOFF_BATCH_SYSTEM_PROMPT = `Ты — Nash Equilibrium Analyst для продуктовых решений.

Твоя задача: оценить только переданную пачку strategy profiles.

ПРАВИЛА:
- Оценивай payoffs в диапазоне от -10 до 10.
- Каждый payoff отражает рациональный интерес конкретного игрока.
- Не придумывай новые profiles и не пропускай переданные profile_id.
- Для каждого profile верни payoff каждого playerId.
- Не пиши общие выводы, рекомендации, rawThinking или markdown.

Верни строго JSON:
{
  "profiles": [
    {
      "id": "profile_1",
      "payoffs": {"p1": 0, "p2": 0},
      "feasible": true,
      "summary": "краткое объяснение профиля"
    }
  ]
}`;

const PAYOFF_SYNTHESIS_SYSTEM_PROMPT = `Ты — Nash Equilibrium Analyst для продуктовых решений.

Твоя задача: по уже оценённым payoff profiles собрать краткую продуктовую интерпретацию игры.

ПРАВИЛА:
- Не пересчитывай payoffs и не меняй переданные профили.
- Сфокусируйся на типе игры, ключевых инсайтах, рисках нарушения равновесия, рекомендациях и чувствительности модели.
- Пиши по-русски.
- Не пиши rawThinking и длинный анализ: этот этап должен быть компактным. Развёрнутая статья генерируется отдельным запросом.
- Не предлагай изменения в PRD.

Верни строго JSON:
{
  "gameType": "string",
  "keyInsights": ["string", "string", "string"],
  "breakEquilibriumMoves": ["string", "string"],
  "recommendations": ["string", "string", "string"],
  "sensitivityChecks": [
    {
      "omittedPlayerId": "string",
      "impact": "low|medium|high",
      "note": "string"
    }
  ],
  "confidence": 0-100
}`;

const AGENT_ARTICLE_SYSTEM_PROMPT = `Ты пишешь раздел «Развёрнутый анализ агента» для продуктового менеджера.

Задача: превратить рассчитанную Nash-модель в связную, понятную статью на русском языке, похожую по формату на объяснительный продуктово-экономический разбор. Не пиши сухой отчёт, список выводов или технический лог. Пиши как автор, который объясняет механику игры через человеческие стимулы, продуктовые ограничения и последствия для стратегии.

Стиль:
- русский язык;
- живой, ясный, аналитический тон;
- формат короткой статьи на 5-8 абзацев;
- объём: 3 000-5 000 знаков;
- без markdown-таблиц;
- без JSON;
- без канцелярита;
- не пересказывай PRD и не предлагай правки PRD;
- не используй английские термины, если есть нормальный русский эквивалент;
- термин payoff заменяй на «выигрыш», «полезность», «ценность» или «стимул».

Структура статьи:
1. Открой с простой идеи: какая игра здесь происходит. Объясни, что равновесие Нэша в этом кейсе показывает не «лучшее желание продукта», а устойчивую конфигурацию стимулов, где каждый актор выбирает рационально, учитывая ожидаемые действия остальных.
2. Дай человеческую или рыночную аналогию. Используй короткую аналогию, похожую на дилемму заключённого, супермаркет браков или рынок внимания: покажи, как индивидуально рациональные действия могут приводить к плохому коллективному результату. Аналогия должна быть связана с данным продуктовым кейсом, а не быть отвлечённой лекцией.
3. Перейди к конкретной фиче. Назови фичу и объясни, какой общий ресурс делят акторы: внимание пользователя, надёжность внешнего API, предложение продавцов, операционная нагрузка, доверие, маржа, скорость запуска или другой ресурс из входных данных.
4. Разбери акторов через стимулы. Для каждого ключевого актора объясни, чего он хочет, какая стратегия для него рациональна, почему его рациональный выбор может помогать или мешать другим, где возникает конфликт стимулов.
5. Объясни плохое равновесие. Покажи сценарий, в котором каждый действует логично для себя, но продукт получает слабый результат: низкое принятие фичи, рост нагрузки, недоверие, зависимость от партнёра, падение конверсии или другой риск из модели.
6. Объясни рекомендуемое равновесие. Опиши, почему выбранный Nash-профиль или рекомендованный профиль устойчивее остальных. Не ограничивайся «у него высокий score»: объясни, какие стимулы в нём выровнены и почему игрокам невыгодно резко отклоняться.
7. Покажи, что должен сделать продукт. Сформулируй продуктовый вывод: какие системные изменения должны изменить правила игры, а не просто попросить игроков вести себя лучше. Это могут быть ограничения, дефолты, цены, SLA, rollout, обучение, поддержка, сегментация, UX-механика, ограничители запуска. Не предлагай редактировать PRD.
8. Заверши сильным выводом. Последний абзац должен звучать как стратегический вывод для PM: какую игру мы на самом деле проектируем и как вывести участников из плохого равновесия в полезное.

Выход:
Верни только текст статьи для раздела «Развёрнутый анализ агента».
Не добавляй заголовок «Развёрнутый анализ агента».
Не добавляй служебные комментарии.`;

const INTEGRATED_ARTICLE_SYSTEM_PROMPT = `Ты пишешь раздел «Развёрнутый совмещённый вывод» для генерального директора компании.

Контекст: читатель не обязан знать теорию игр, равновесие Нэша, экономику сложности, ход расчётов, игроков, профили, сценарии или методологию агента. Текст должен сам объяснить, что было проверено, почему это важно для бизнеса и как из анализа следует управленческое решение.

Задача: превратить результаты двух аналитических слоёв — равновесия Нэша и экономики сложности — в связную объясняющую статью на русском языке. Не пиши технический лог и не ограничивайся выводами. Объясняй так, чтобы руководитель понял, какая бизнес-игра разворачивается вокруг фичи или стратегии, почему хороший статический план может не реализоваться в динамике и что нужно сделать до разработки или запуска.

Стиль:
- русский язык без англицизмов, если есть нормальный русский эквивалент;
- живой, ясный, управленческий тон;
- формат объясняющей статьи на 9-14 абзацев;
- объём: 6 000-9 000 знаков;
- без JSON и markdown-таблиц;
- можно использовать короткие смысловые подзаголовки обычным текстом;
- не предполагай, что читатель видел предыдущие экраны агента;
- не пересказывай весь исходный документ, но дай достаточно контекста кейса;
- не предлагай «просто мониторить» без объяснения, какие решения должны следовать из сигналов;
- термин payoff заменяй на «выигрыш», «полезность», «ценность» или «стимул»;
- термин Nash можно использовать только как «равновесие Нэша» и сразу объяснять смысл простыми словами.

Обязательная структура:
1. Начни с краткого резюме для руководителя: что анализировали, какой итоговый вердикт и почему он не сводится к одной метрике.
2. Объясни метод простыми словами: равновесие Нэша показывает устойчивость стимулов в статичной игре, экономика сложности показывает, как система реально движется во времени через адаптацию игроков, обратные связи и ранние события.
3. Объясни, кто является ключевыми игроками в этом кейсе и почему они не просто «стейкхолдеры», а участники игры с собственными стимулами.
4. Расскажи, что показал слой равновесия Нэша: какой профиль выглядит устойчивым или неустойчивым, какие стимулы выровнены, где есть риск односторонних отклонений.
5. Расскажи, что показал слой экономики сложности: какие переменные состояния, обратные связи, пороговые переломы и ранние события могут изменить траекторию.
6. Объясни расхождение или согласие двух подходов. Если статическая устойчивость высокая, а динамическая низкая, явно напиши: «на бумаге равновесие есть, но система может до него не дойти». Если наоборот, объясни, что нужно менять в правилах игры.
7. Объясни метрику достижимости равновесия как управленческий показатель: это не вероятность успеха вообще, а оценка того, насколько реальные реакции игроков способны привести систему к целевому устойчивому профилю.
8. Разбери плохую траекторию: как рациональные действия отдельных игроков могут привести к слабому результату для продукта.
9. Разбери желаемую траекторию: какие условия должны быть созданы, чтобы игрокам было выгодно двигаться к полезному профилю.
10. Сформулируй решение для руководителя: запускать, запускать пилотом, менять условия, ставить на паузу или отменять; объясни экономический смысл решения.
11. Заверши сильным стратегическим выводом: какую систему поведения компания на самом деле проектирует этой фичей или стратегией.

Выход:
Верни только текст статьи для раздела «Развёрнутый совмещённый вывод».
Не добавляй служебные комментарии, JSON или технические пояснения о промпте.`;

const DECISION_SYSTEM_PROMPT = `Ты — Product Strategy Chief of Staff для менеджера продукта.

Твоя задача: превратить готовую Nash-модель в прикладной PM Decision Pack.

ПРАВИЛА:
- Не переписывай PRD и не предлагай изменения в PRD.
- Не повторяй общие рекомендации. Дай конкретные ходы, эксперименты, guardrails, playbook против контрходов и открытые вопросы.
- Каждый strategic move должен объяснять, чьи стимулы он меняет и почему это повышает устойчивость рекомендованного профиля.
- Experiment plan должен содержать метрику успеха, guardrail-метрику, success criterion, kill criterion и timebox.
- Counter-move playbook должен связывать угрозу, ранний сигнал и реакцию команды.
- Используй только playerId из переданной игры, если ход нацелен на конкретного игрока; иначе используй "system".
- Пиши по-русски, кратко и операционно.
- Все пользовательские текстовые значения в JSON должны быть на русском языке. Не оставляй английские фразы вроде "Support ticket volume", "Checkout conversion rate", "Success", "Kill", "Guardrail"; переводи их.

Верни строго JSON:
{
  "executiveSummary": "string",
  "recommendedDecision": "launch|revise|pause|kill",
  "whyNow": "string",
  "targetEquilibrium": "profile_1|null",
  "topStrategicMoves": [
    {
      "title": "string",
      "objective": "string",
      "targetPlayerId": "p1|p2|system",
      "changesIncentiveHow": "string",
      "expectedNashScoreDelta": 0,
      "expectedPayoffDelta": {"p1": 0, "p2": 0},
      "effort": "S|M|L",
      "confidence": 0-100,
      "priority": 1
    }
  ],
  "experimentPlan": [
    {
      "hypothesis": "string",
      "metric": "string",
      "guardrailMetric": "string",
      "successCriterion": "string",
      "killCriterion": "string",
      "timebox": "string"
    }
  ],
  "launchGuardrails": ["string"],
  "counterMovePlaybook": [
    {
      "threat": "string",
      "earlySignal": "string",
      "mitigation": "string"
    }
  ],
  "openQuestions": ["string"]
}`;

interface SetupPromptPlayer {
  name?: string;
  type?: string;
  incentives?: string;
  strategies?: unknown;
  weight?: number;
}

interface StrategicSetupResponse {
  players?: SetupPromptPlayer[];
  aggregatedActors?: unknown;
  assumptions?: unknown;
  caseFrame?: string;
}

interface PayoffPromptProfile {
  id?: string;
  payoffs?: Record<string, unknown>;
  feasible?: boolean;
  summary?: string;
}

interface PayoffAssessmentResponse {
  profiles?: PayoffPromptProfile[];
  gameType?: string;
  keyInsights?: unknown;
  breakEquilibriumMoves?: unknown;
  recommendations?: unknown;
  sensitivityChecks?: unknown;
  confidence?: number;
  rawThinking?: string;
}

interface PayoffBatchResponse {
  profiles?: PayoffPromptProfile[];
}

interface PayoffSynthesisResponse {
  gameType?: string;
  keyInsights?: unknown;
  breakEquilibriumMoves?: unknown;
  recommendations?: unknown;
  sensitivityChecks?: unknown;
  confidence?: number;
  rawThinking?: string;
}

interface DecisionPackResponse {
  executiveSummary?: string;
  recommendedDecision?: string;
  whyNow?: string;
  targetEquilibrium?: string | null;
  topStrategicMoves?: unknown;
  experimentPlan?: unknown;
  launchGuardrails?: unknown;
  counterMovePlaybook?: unknown;
  openQuestions?: unknown;
}

interface DecisionPackPromptMove {
  title?: string;
  objective?: string;
  targetPlayerId?: string;
  changesIncentiveHow?: string;
  expectedNashScoreDelta?: number;
  expectedPayoffDelta?: Record<string, unknown>;
  effort?: string;
  confidence?: number;
  priority?: number;
}

interface DecisionPackPromptExperiment {
  hypothesis?: string;
  metric?: string;
  guardrailMetric?: string;
  successCriterion?: string;
  killCriterion?: string;
  timebox?: string;
}

interface DecisionPackPromptCounterMove {
  threat?: string;
  earlySignal?: string;
  mitigation?: string;
}

interface PreparedPlayers {
  players: Player[];
  notes: string[];
}

type AnalysisProgressPhase = "queued" | "setup" | "payoff" | "finalizing" | "done" | "error" | "cancelled";
type AnalysisProgressStepId =
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

interface AnalysisLiveProgress {
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

const MAX_STREAM_PREVIEW_CHARS = 24_000;
const ANALYSIS_PROGRESS_TTL_MS = 15 * 60 * 1000;
const ANALYSIS_PROGRESS_STEPS: AnalysisProgressStepId[] = [
  "prepare_request",
  "setup_players",
  "build_profiles",
  "score_profiles",
  "compute_equilibrium",
  "agent_article",
  "decision_pack",
  "integrated_nash_setup",
  "integrated_nash_profiles",
  "integrated_nash_payoffs",
  "integrated_nash_equilibrium",
  "integrated_nash_article",
  "integrated_nash_decision",
  "integrated_complexity_setup",
  "integrated_complexity_scenarios",
  "integrated_complexity_simulation",
  "integrated_complexity_regimes",
  "integrated_complexity_article",
  "integrated_complexity_decision",
  "integrated_synthesis",
];
const analysisLiveProgress = new Map<number, AnalysisLiveProgress>();
const analysisProgressCleanupTimers = new Map<number, ReturnType<typeof setTimeout>>();
const activeAnalysisControllers = new Map<number, AbortController>();
const analysisRuntimeModels = new Map<number, string>();
const analysisRuntimeConfigs = new Map<number, ProviderSettings & { provider: LlmProvider }>();

interface LlmCheckWaiter {
  resolve: (model: string) => void;
  reject: (error: unknown) => void;
  cleanup?: () => void;
}

const llmCheckWaiters = new Map<number, LlmCheckWaiter>();

class AnalysisCancelledError extends Error {
  constructor(message = "Анализ остановлен пользователем") {
    super(message);
    this.name = "AnalysisCancelledError";
  }
}

type QueuedLlmTask<T> = () => Promise<T>;

interface QueuedLlmRequest<T> {
  task: QueuedLlmTask<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  cleanup?: () => void;
}

class LlmRequestQueue {
  private queue: QueuedLlmRequest<unknown>[] = [];
  private running = false;

  run<T>(
    task: QueuedLlmTask<T>,
    signal?: AbortSignal,
    onQueued?: (position: number) => void,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new AnalysisCancelledError());
    }

    return new Promise<T>((resolve, reject) => {
      const request: QueuedLlmRequest<T> = {
        task,
        resolve,
        reject,
        signal,
      };

      const abortQueuedRequest = () => {
        const index = this.queue.indexOf(request as QueuedLlmRequest<unknown>);
        if (index >= 0) {
          this.queue.splice(index, 1);
          reject(new AnalysisCancelledError());
        }
      };

      if (signal) {
        signal.addEventListener("abort", abortQueuedRequest, { once: true });
        request.cleanup = () => signal.removeEventListener("abort", abortQueuedRequest);
      }

      this.queue.push(request as QueuedLlmRequest<unknown>);
      if (this.running || this.queue.length > 1) {
        onQueued?.(this.queue.length);
      }
      void this.process();
    });
  }

  private async process() {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      while (this.queue.length > 0) {
        const request = this.queue.shift();
        if (!request) {
          continue;
        }

        if (request.signal?.aborted) {
          request.cleanup?.();
          request.reject(new AnalysisCancelledError());
          continue;
        }

        try {
          const value = await request.task();
          request.resolve(value);
        } catch (error) {
          request.reject(error);
        } finally {
          request.cleanup?.();
        }
      }
    } finally {
      this.running = false;
    }
  }
}

const llmRequestQueue = new LlmRequestQueue();

function readNumberEnv(name: string, fallback: number): number {
  const value = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeProvider(value: unknown): LlmProvider {
  return value === "yandex" ? "yandex" : "local";
}

function getDefaultSettings(): AppSettings {
  return {
    llmProvider: normalizeProvider(process.env.LLM_PROVIDER),
    local: {
      baseURL: (process.env.OPENAI_BASE_URL || "http://127.0.0.1:1234/v1").trim(),
      apiKey: (process.env.OPENAI_API_KEY || "lm-studio").trim(),
      model: (process.env.LLM_MODEL || "auto").trim(),
      timeoutMs: readIntEnv("LLM_TIMEOUT_MS", 15 * 60 * 1000),
    },
    yandex: {
      baseURL: (process.env.YANDEX_AI_STUDIO_BASE_URL || "https://ai.api.cloud.yandex.net/v1").trim(),
      apiKey: (process.env.YANDEX_AI_STUDIO_API_KEY || "").trim(),
      projectId: (process.env.YANDEX_AI_STUDIO_PROJECT_ID || "b1gjb9f0e5t7ii1s2p9l").trim(),
      model: (
        process.env.YANDEX_AI_STUDIO_MODEL ||
        "gpt://b1gjb9f0e5t7ii1s2p9l/qwen3.5-35b-a3b-fp8/latest"
      ).trim(),
      timeoutMs: readIntEnv("YANDEX_AI_STUDIO_TIMEOUT_MS", 15 * 60 * 1000),
      maxOutputTokens: readIntEnv("YANDEX_AI_STUDIO_MAX_OUTPUT_TOKENS", 40000),
      temperature: readNumberEnv("YANDEX_AI_STUDIO_TEMPERATURE", 0.8),
    },
  };
}

function normalizeProviderSettings(
  value: Partial<ProviderSettings> | undefined,
  fallback: ProviderSettings
): ProviderSettings {
  return {
    baseURL: typeof value?.baseURL === "string" && value.baseURL.trim() ? value.baseURL.trim() : fallback.baseURL,
    apiKey: typeof value?.apiKey === "string" && value.apiKey.trim() ? value.apiKey.trim() : fallback.apiKey,
    model: typeof value?.model === "string" && value.model.trim() ? value.model.trim() : fallback.model,
    timeoutMs:
      typeof value?.timeoutMs === "number" && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0
        ? Math.round(value.timeoutMs)
        : fallback.timeoutMs,
    maxOutputTokens:
      typeof value?.maxOutputTokens === "number" &&
      Number.isFinite(value.maxOutputTokens) &&
      value.maxOutputTokens > 0
        ? Math.round(value.maxOutputTokens)
        : fallback.maxOutputTokens,
    temperature:
      typeof value?.temperature === "number" && Number.isFinite(value.temperature) && value.temperature >= 0
        ? value.temperature
        : fallback.temperature,
    projectId:
      typeof value?.projectId === "string" && value.projectId.trim()
        ? value.projectId.trim()
        : fallback.projectId,
  };
}

function readAppSettings(): AppSettings {
  const defaults = getDefaultSettings();
  try {
    if (!fs.existsSync(SETTINGS_FILE_PATH)) {
      return defaults;
    }

    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, "utf8")) as Partial<AppSettings>;
    return {
      llmProvider: normalizeProvider(parsed.llmProvider || defaults.llmProvider),
      local: normalizeProviderSettings(parsed.local, defaults.local),
      yandex: normalizeProviderSettings(parsed.yandex, defaults.yandex),
    };
  } catch (error) {
    console.warn("[settings] failed to read settings file:", getErrorMessage(error));
    return defaults;
  }
}

function writeAppSettings(settings: AppSettings): AppSettings {
  const normalized: AppSettings = {
    llmProvider: normalizeProvider(settings.llmProvider),
    local: normalizeProviderSettings(settings.local, getDefaultSettings().local),
    yandex: normalizeProviderSettings(settings.yandex, getDefaultSettings().yandex),
  };

  fs.writeFileSync(SETTINGS_FILE_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

function toPublicProviderSettings(settings: ProviderSettings): PublicProviderSettings {
  const { apiKey: _apiKey, ...publicSettings } = settings;
  return {
    ...publicSettings,
    apiKeySet: Boolean(settings.apiKey.trim()),
  };
}

function toPublicAppSettings(settings: AppSettings): PublicAppSettings {
  return {
    llmProvider: settings.llmProvider,
    local: toPublicProviderSettings(settings.local),
    yandex: toPublicProviderSettings(settings.yandex),
  };
}

function mergeSettingsPatch(current: AppSettings, patch: unknown): AppSettings {
  const input = typeof patch === "object" && patch !== null ? patch as Partial<AppSettings> : {};
  const next: AppSettings = {
    llmProvider: normalizeProvider(input.llmProvider || current.llmProvider),
    local: { ...current.local },
    yandex: { ...current.yandex },
  };

  const mergeProvider = (
    provider: "local" | "yandex",
    value: unknown,
  ) => {
    if (!value || typeof value !== "object") {
      return;
    }

    const raw = value as Partial<ProviderSettings> & { apiKey?: unknown };
    const existing = next[provider];
    next[provider] = normalizeProviderSettings(
      {
        baseURL: raw.baseURL,
        model: raw.model,
        timeoutMs: raw.timeoutMs,
        maxOutputTokens: raw.maxOutputTokens,
        temperature: raw.temperature,
        projectId: raw.projectId,
        apiKey:
          typeof raw.apiKey === "string" && raw.apiKey.trim()
            ? raw.apiKey.trim()
            : existing.apiKey,
      },
      existing,
    );
  };

  mergeProvider("local", input.local);
  mergeProvider("yandex", input.yandex);
  return next;
}

function getActiveLlmConfig(settings = readAppSettings()): ProviderSettings & { provider: LlmProvider } {
  const provider = normalizeProvider(settings.llmProvider);
  return {
    provider,
    ...(provider === "yandex" ? settings.yandex : settings.local),
  };
}

function getRuntimeLlmConfig(analysisId: number): ProviderSettings & { provider: LlmProvider } {
  return analysisRuntimeConfigs.get(analysisId) || getActiveLlmConfig();
}

function createOpenAIClient(config: ProviderSettings): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey || "lm-studio",
    baseURL: config.baseURL,
    project: config.projectId || undefined,
    timeout: config.timeoutMs,
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildInitialLiveProgress(): AnalysisLiveProgress {
  const now = Date.now();

  return {
    phase: "queued",
    phaseLabel: "Анализ запущен",
    llmStatus: "Подготавливаем запрос к LLM",
    previewText: "",
    profileCount: null,
    profileProcessedCount: null,
    requiresLlmCheck: false,
    llmCheckMessage: null,
    activeStepId: "prepare_request",
    completedStepIds: [],
    startedAt: now,
    updatedAt: now,
    lastChunkAt: null,
    chunks: 0,
    error: null,
  };
}

function trimStreamPreview(value: string): string {
  return value.length <= MAX_STREAM_PREVIEW_CHARS
    ? value
    : value.slice(-MAX_STREAM_PREVIEW_CHARS);
}

function ensureLiveProgress(id: number): AnalysisLiveProgress {
  const existing = analysisLiveProgress.get(id);
  if (existing) {
    return existing;
  }

  const initial = buildInitialLiveProgress();
  analysisLiveProgress.set(id, initial);
  return initial;
}

function updateLiveProgress(
  id: number,
  patch: Partial<AnalysisLiveProgress>,
): AnalysisLiveProgress {
  const current = ensureLiveProgress(id);
  const next: AnalysisLiveProgress = {
    ...current,
    ...patch,
    previewText: trimStreamPreview(patch.previewText ?? current.previewText),
    updatedAt: Date.now(),
  };

  analysisLiveProgress.set(id, next);
  return next;
}

function appendLivePreview(
  id: number,
  chunk: string,
  patch: Partial<AnalysisLiveProgress> = {},
  countChunk = true,
): AnalysisLiveProgress {
  const current = ensureLiveProgress(id);
  const nextPreview = chunk ? trimStreamPreview(`${current.previewText}${chunk}`) : current.previewText;
  const now = Date.now();
  const next: AnalysisLiveProgress = {
    ...current,
    ...patch,
    previewText: nextPreview,
    updatedAt: now,
    lastChunkAt: chunk && countChunk ? now : patch.lastChunkAt ?? current.lastChunkAt,
    chunks: chunk && countChunk ? current.chunks + 1 : patch.chunks ?? current.chunks,
  };

  analysisLiveProgress.set(id, next);
  return next;
}

function appendPhaseHeader(id: number, label: string): void {
  const current = ensureLiveProgress(id);
  const prefix = current.previewText.trim().length > 0 ? "\n\n" : "";
  appendLivePreview(id, `${prefix}=== ${label} ===\n`, {}, false);
}

function activateAnalysisStep(
  id: number,
  activeStepId: AnalysisProgressStepId,
  patch: Partial<AnalysisLiveProgress> = {},
): AnalysisLiveProgress {
  return updateLiveProgress(id, {
    ...patch,
    activeStepId,
  });
}

function completeAnalysisStep(id: number, stepId: AnalysisProgressStepId): AnalysisLiveProgress {
  const current = ensureLiveProgress(id);
  const completedStepIds = current.completedStepIds.includes(stepId)
    ? current.completedStepIds
    : [...current.completedStepIds, stepId].sort(
        (left, right) => ANALYSIS_PROGRESS_STEPS.indexOf(left) - ANALYSIS_PROGRESS_STEPS.indexOf(right)
      );

  return updateLiveProgress(id, { completedStepIds });
}

function completeAllAnalysisSteps(id: number): AnalysisLiveProgress {
  return updateLiveProgress(id, {
    activeStepId: null,
    completedStepIds: [...ANALYSIS_PROGRESS_STEPS],
  });
}

function buildRuntimeStats(id: number): NonNullable<AnalysisResult["runtimeStats"]> {
  const progress = ensureLiveProgress(id);

  return {
    durationMs: Math.max(0, Date.now() - progress.startedAt),
    chunks: progress.chunks,
  };
}

function countScoredProfilesFromText(content: string, totalProfiles: number, profileIds?: string[]): number {
  const expected = profileIds?.length
    ? new Set(profileIds.map((id) => id.toLowerCase()))
    : null;
  const seen = new Set<string>();
  const pattern = /profile_(\d+)/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const profileNumber = Number.parseInt(match[1], 10);
    if (Number.isFinite(profileNumber) && profileNumber >= 1 && profileNumber <= totalProfiles) {
      const profileId = `profile_${profileNumber}`.toLowerCase();
      if (!expected || expected.has(profileId)) {
        seen.add(profileId);
      }
    }
  }

  return Math.min(seen.size, expected?.size || totalProfiles);
}

interface RequestJsonProgressOptions {
  profileCount?: number;
  profileProcessedCount?: number;
  profileIds?: string[];
  maxAttempts?: number;
  stream?: boolean;
}

async function runQueuedLlmTask<T>(
  analysisId: number,
  phase: AnalysisProgressPhase,
  phaseLabel: string,
  signal: AbortSignal | undefined,
  task: QueuedLlmTask<T>,
): Promise<T> {
  return llmRequestQueue.run(
    task,
    signal,
    (position) => {
      updateLiveProgress(analysisId, {
        phase,
        phaseLabel,
        llmStatus: `Запрос ждёт очередь LLM: позиция ${position}`,
      });
    },
  );
}

function resolveLlmCheckWaiter(id: number, model: string): boolean {
  const waiter = llmCheckWaiters.get(id);
  if (!waiter) {
    return false;
  }

  llmCheckWaiters.delete(id);
  waiter.cleanup?.();
  waiter.resolve(model);
  return true;
}

function rejectLlmCheckWaiter(id: number, error: unknown): boolean {
  const waiter = llmCheckWaiters.get(id);
  if (!waiter) {
    return false;
  }

  llmCheckWaiters.delete(id);
  waiter.cleanup?.();
  waiter.reject(error);
  return true;
}

async function waitForUserLlmCheck(
  analysisId: number,
  phase: AnalysisProgressPhase,
  phaseLabel: string,
  errorMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);

  const message =
    "LM Studio потерял, выгрузил или перегрузил модель. Загрузите нужную LLM в LM Studio и нажмите «Проверить загруженную LLM», после этого агент повторит тот же запрос.";

  rejectLlmCheckWaiter(
    analysisId,
    new Error("Предыдущая проверка LLM заменена новым ожиданием")
  );

  appendLivePreview(
    analysisId,
    `\n\n[${phaseLabel}] LM Studio не готов выполнить запрос: ${errorMessage}\nОжидаем проверку загруженной LLM пользователем.\n`,
    {
      phase,
      phaseLabel,
      llmStatus: message,
      requiresLlmCheck: true,
      llmCheckMessage: message,
      error: null,
    },
    false,
  );

  const model = await new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      llmCheckWaiters.delete(analysisId);
      reject(new AnalysisCancelledError());
    };

    if (signal?.aborted) {
      reject(new AnalysisCancelledError());
      return;
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    llmCheckWaiters.set(analysisId, {
      resolve,
      reject,
      cleanup: signal ? () => signal.removeEventListener("abort", onAbort) : undefined,
    });
  });

  updateLiveProgress(analysisId, {
    phase,
    phaseLabel,
    llmStatus: `LLM загружена: ${model}. Повторяем тот же запрос…`,
    requiresLlmCheck: false,
    llmCheckMessage: null,
    error: null,
  });
  analysisRuntimeModels.set(analysisId, model);
  appendLivePreview(
    analysisId,
    `\n[${phaseLabel}] LLM загружена (${model}). Повторяем тот же запрос.\n`,
    {},
    false,
  );

  return model;
}

function scheduleLiveProgressCleanup(id: number): void {
  const existingTimer = analysisProgressCleanupTimers.get(id);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    analysisLiveProgress.delete(id);
    analysisProgressCleanupTimers.delete(id);
  }, ANALYSIS_PROGRESS_TTL_MS);

  timer.unref?.();
  analysisProgressCleanupTimers.set(id, timer);
}

function disposeAnalysisArtifacts(id: number): void {
  rejectLlmCheckWaiter(id, new AnalysisCancelledError("Анализ удалён"));
  analysisLiveProgress.delete(id);
  activeAnalysisControllers.delete(id);
  analysisRuntimeModels.delete(id);
  analysisRuntimeConfigs.delete(id);

  const cleanupTimer = analysisProgressCleanupTimers.get(id);
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    analysisProgressCleanupTimers.delete(id);
  }
}

function isTerminalAnalysisStatus(status: string | null | undefined): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof AnalysisCancelledError) {
    return true;
  }

  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }

  if (error instanceof Error) {
    const combined = `${error.name} ${error.message}`.toLowerCase();
    return (
      error.name === "AbortError" ||
      error.name === "APIUserAbortError" ||
      combined.includes("abort") ||
      combined.includes("cancelled") ||
      combined.includes("canceled")
    );
  }

  return false;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AnalysisCancelledError();
  }
}

function finalizeLiveProgress(
  id: number,
  status: "done" | "error" | "cancelled",
  errorMessage?: string
): void {
  const current = ensureLiveProgress(id);
  if (
    current.phase === status &&
    (status === "done" || current.error === (errorMessage || current.error))
  ) {
    scheduleLiveProgressCleanup(id);
    return;
  }

  if (status === "done") {
    appendLivePreview(id, "\n\n[done] Итоговый JSON получен. Дашборд готов.\n", {
      phase: "done",
      phaseLabel: "Анализ завершён",
      llmStatus: "Результат готов",
      requiresLlmCheck: false,
      llmCheckMessage: null,
      activeStepId: null,
      completedStepIds: [...ANALYSIS_PROGRESS_STEPS],
      error: null,
    }, false);
  } else if (status === "cancelled") {
    appendLivePreview(id, `\n\n[cancelled] ${errorMessage || "Анализ остановлен пользователем"}\n`, {
      phase: "cancelled",
      phaseLabel: "Анализ остановлен",
      llmStatus: errorMessage || "Запрос к модели отменён",
      requiresLlmCheck: false,
      llmCheckMessage: null,
      activeStepId: null,
      error: errorMessage || "Анализ остановлен пользователем",
    }, false);
  } else {
    appendLivePreview(id, `\n\n[error] ${errorMessage || "Анализ завершился ошибкой"}\n`, {
      phase: "error",
      phaseLabel: "Анализ завершился ошибкой",
      llmStatus: errorMessage || "Не удалось получить пригодный ответ от LLM",
      requiresLlmCheck: false,
      llmCheckMessage: null,
      activeStepId: null,
      error: errorMessage || "Analysis failed",
    }, false);
  }

  scheduleLiveProgressCleanup(id);
}

function persistAnalysisResult(id: number, result: string, status: "running" | "done" | "error" | "cancelled") {
  const updated = storage.updateAnalysisResult(id, result, status);

  if (!updated) {
    console.error(`[analysis] failed to persist status="${status}" for id=${id}`);
  }

  return updated;
}

function cancelAnalysisExecution(id: number, reason = "Анализ остановлен пользователем") {
  rejectLlmCheckWaiter(id, new AnalysisCancelledError(reason));

  const controller = activeAnalysisControllers.get(id);
  if (controller && !controller.signal.aborted) {
    controller.abort(reason);
  }

  const updated = persistAnalysisResult(
    id,
    JSON.stringify({ error: reason, cancelled: true }),
    "cancelled"
  );
  finalizeLiveProgress(id, "cancelled", reason);
  return updated;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeTextList(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const items = uniqueStrings(
    value
      .map((item) => (typeof item === "string" ? item : ""))
      .filter(Boolean)
  );

  return items.length > 0 ? items : fallback;
}

function normalizePlayerType(value: string | undefined): Player["type"] {
  switch (value) {
    case "competitor":
    case "partner":
    case "regulator":
    case "user":
    case "platform":
    case "other":
      return value;
    default:
      return "other";
  }
}

function defaultWeightForType(type: Player["type"]): number {
  switch (type) {
    case "competitor":
      return 5;
    case "user":
      return 5;
    case "regulator":
      return 4;
    case "platform":
      return 4;
    case "partner":
      return 3;
    default:
      return 3;
  }
}

function normalizePlayer(raw: SetupPromptPlayer | Player, index: number, source: Player["source"]): Player | null {
  const name = raw.name?.trim();
  if (!name) {
    return null;
  }

  const type = normalizePlayerType(raw.type);
  const strategies = Array.isArray(raw.strategies)
    ? uniqueStrings(
        raw.strategies
          .map((strategy) => (typeof strategy === "string" ? strategy : ""))
          .filter(Boolean)
      ).slice(0, 3)
    : [];

  if (strategies.length < 2) {
    return null;
  }

  return {
    id: `p${index + 1}`,
    name,
    type,
    strategies,
    incentives: raw.incentives?.trim() || "",
    tier: "core",
    weight: clamp(Math.round(raw.weight ?? defaultWeightForType(type)), 1, 5),
    source,
  };
}

function parsePlayersInput(value: string): Player[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((player, index) => normalizePlayer(player as SetupPromptPlayer, index, "user"))
      .filter((player): player is Player => Boolean(player));
  } catch {
    return [];
  }
}

function totalProfileCount(players: Player[]): number {
  return players.reduce((count, player) => count * Math.max(player.strategies.length, 1), 1);
}

function prepareCorePlayers(players: Player[]): PreparedPlayers {
  const notes: string[] = [];
  const normalized = players
    .map((player, index) => normalizePlayer(player, index, player.source ?? "inferred"))
    .filter((player): player is Player => Boolean(player));

  if (normalized.length < 2) {
    throw new Error("Недостаточно игроков для построения игры");
  }

  const focal = {
    ...normalized[0],
    id: "p1",
    weight: clamp(Math.max(normalized[0].weight ?? 5, 5), 1, 5),
  };

  const others = normalized
    .slice(1)
    .sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0))
    .slice(0, MAX_CORE_PLAYERS - 1)
    .map((player, index) => ({ ...player, id: `p${index + 2}` }));

  const selected = [focal, ...others];

  if (normalized.length > selected.length) {
    notes.push(`Игра сжата до ${selected.length} core players, чтобы сохранить управляемый размер strategy space.`);
  }

  while (totalProfileCount(selected) > MAX_PROFILE_BUDGET) {
    const reducibleIndex = selected
      .map((player, index) => ({ player, index }))
      .slice(1)
      .reverse()
      .find(({ player }) => player.strategies.length > 2)?.index;

    if (reducibleIndex === undefined) {
      break;
    }

    selected[reducibleIndex] = {
      ...selected[reducibleIndex],
      strategies: selected[reducibleIndex].strategies.slice(0, 2),
    };
  }

  if (totalProfileCount(selected) > MAX_PROFILE_BUDGET) {
    notes.push(`Часть стратегий была усечена до 2 вариантов, чтобы уложиться в ${MAX_PROFILE_BUDGET} profiles.`);
  }

  return { players: selected, notes };
}

function buildCaseBrief(
  type: string,
  title: string,
  description: string,
  context: string,
  hintedPlayers: Player[]
): string {
  const playersHint = hintedPlayers.length
    ? hintedPlayers
        .map(
          (player) =>
            `- ${player.name} (${player.type}): стратегии [${player.strategies.join(", ")}], мотивация: ${player.incentives}`
        )
        .join("\n")
    : "Нет явных игроков от пользователя. Их нужно вывести из кейса.";

  return `## Объект анализа
Тип: ${type === "strategy" ? "Продуктовая стратегия" : "Фича"}
Название: ${title}
Описание: ${description}

## Контекст
${context || "Не указан"}

## Подсказки пользователя по игрокам
${playersHint}`;
}

function buildSetupUserPrompt(
  type: string,
  title: string,
  description: string,
  context: string,
  hintedPlayers: Player[]
): string {
  return `${buildCaseBrief(type, title, description, context, hintedPlayers)}

Собери compact core game. Сделай так, чтобы:
- первый игрок был фокальным актором;
- остальные игроки реально меняли launch decision;
- число profiles не превышало ${MAX_PROFILE_BUDGET}.`;
}

function buildProfilesUserPrompt(
  type: string,
  title: string,
  description: string,
  context: string,
  players: Player[],
  assumptions: string[],
  caseFrame: string,
  profiles: StrategyProfile[],
  aggregatedActors: string[]
): string {
  const playersText = players
    .map(
      (player) =>
        `- ${player.id}: ${player.name} [${player.type}], weight=${player.weight}, incentives=${player.incentives}, strategies=[${player.strategies.join(", ")}]`
    )
    .join("\n");

  const profilesText = profiles
    .map((profile) => {
      const selections = players
        .map((player) => `${player.id}=${profile.selections[player.id]}`)
        .join("; ");
      return `- ${profile.id}: ${selections}`;
    })
    .join("\n");

  return `${buildCaseBrief(type, title, description, context, players)}

## Фрейм игры
${caseFrame || "Не указан"}

## Core players
${playersText}

## Aggregated actors
${aggregatedActors.length ? aggregatedActors.join("\n") : "Нет"}

## Assumptions
${assumptions.length ? assumptions.join("\n") : "Нет дополнительных assumptions"}

## Strategy profiles to score
${profilesText}

Оцени каждый profile по payoff для каждого playerId и верни только JSON.`;
}

function formatPlayersForPrompt(players: Player[]): string {
  return players
    .map(
      (player) =>
        `- ${player.id}: ${player.name} [${player.type}], weight=${player.weight}, incentives=${player.incentives}, strategies=[${player.strategies.join(", ")}]`
    )
    .join("\n");
}

function formatProfilesForPrompt(profiles: StrategyProfile[], players: Player[]): string {
  return profiles
    .map((profile) => {
      const selections = players
        .map((player) => `${player.id}=${profile.selections[player.id]}`)
        .join("; ");
      return `- ${profile.id}: ${selections}`;
    })
    .join("\n");
}

function truncatePromptText(value: string | null | undefined, maxChars: number): string {
  const normalized = (value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function buildCompactCaseBrief(
  type: string,
  title: string,
  description: string,
  context: string
): string {
  return `## Объект анализа
Тип: ${type === "strategy" ? "Продуктовая стратегия" : "Фича / Feature"}
Название: ${title}
Описание: ${truncatePromptText(description, 900) || "Не указано"}

## Контекст
${truncatePromptText(context, 1400) || "Не указан"}`;
}

function buildComplexityCaseBrief(
  type: string,
  title: string,
  description: string,
  context: string
): string {
  return `## Объект анализа
Тип: ${type === "strategy" ? "Продуктовая стратегия" : "Фича"}
Название: ${title}
Описание: ${description}

## Контекст
${context || "Не указан"}`;
}

function buildComplexitySetupUserPrompt(data: {
  type: string;
  title: string;
  description: string;
  context: string;
}): string {
  return `${buildComplexityCaseBrief(data.type, data.title, data.description, data.context)}

Собери модель ограниченной адаптивной симуляции. Нужно подготовить игроков, переменные состояния, обратные связи, пороговые переломы, зависимости от ранних событий, вмешательства и три сценария.`;
}

function formatComplexitySetupForPrompt(setup: NormalizedComplexitySetup): string {
  return JSON.stringify({
    agentsUsed: setup.agentsUsed,
    assumptions: setup.assumptions,
    stateVariables: setup.stateVariables,
    feedbackLoops: setup.feedbackLoops,
    tippingPoints: setup.tippingPoints,
    pathDependencies: setup.pathDependencies,
    interventions: setup.interventions,
  }, null, 2);
}

function formatComplexitySimulationForPrompt(simulation: ReturnType<typeof simulateComplexitySystem>): string {
  return JSON.stringify({
    scenarios: simulation.scenarios,
    dominantRegimes: simulation.dominantRegimes,
    earlySignals: simulation.earlySignals,
    regimeShiftTriggers: simulation.regimeShiftTriggers,
    scores: {
      resilienceScore: simulation.resilienceScore,
      adaptationCapacity: simulation.adaptationCapacity,
      lockInRisk: simulation.lockInRisk,
      cascadeRisk: simulation.cascadeRisk,
      optionalityScore: simulation.optionalityScore,
      confidence: simulation.confidence,
      verdict: simulation.verdict,
    },
  }, null, 2);
}

function buildComplexityArticleUserPrompt(
  data: { type: string; title: string; description: string; context: string },
  setup: NormalizedComplexitySetup,
  simulation: ReturnType<typeof simulateComplexitySystem>,
): string {
  return `${buildComplexityCaseBrief(data.type, data.title, data.description, data.context)}

## Модель системы
${formatComplexitySetupForPrompt(setup)}

## Результат симуляции
${formatComplexitySimulationForPrompt(simulation)}

Напиши развёрнутый анализ траектории системы. Верни только JSON с полем rawThinking.`;
}

function buildComplexityDecisionUserPrompt(
  data: { type: string; title: string; description: string; context: string },
  setup: NormalizedComplexitySetup,
  simulation: ReturnType<typeof simulateComplexitySystem>,
): string {
  return `${buildComplexityCaseBrief(data.type, data.title, data.description, data.context)}

## Модель системы
${formatComplexitySetupForPrompt(setup)}

## Результат симуляции
${formatComplexitySimulationForPrompt(simulation)}

Собери управленческий вывод для менеджера продукта. Верни строго JSON по схеме.`;
}

function formatScoredProfilesForSynthesis(profiles: StrategyProfile[], players: Player[]): string {
  return profiles
    .map((profile) => {
      const selections = players
        .map((player) => `${player.id}=${profile.selections[player.id]}`)
        .join("; ");
      const payoffs = players
        .map((player) => `${player.id}=${profile.payoffs[player.id] ?? 0}`)
        .join("; ");
      const summary = truncatePromptText(profile.summary || "нет", 140);

      return `- ${profile.id}: ${selections}; выигрыши: ${payoffs}; feasible=${profile.feasible}; summary=${summary}`;
    })
    .join("\n");
}

function buildProfilesBatchUserPrompt(
  data: { type: string; title: string; description: string; context: string },
  players: Player[],
  assumptions: string[],
  caseFrame: string,
  profiles: StrategyProfile[],
  aggregatedActors: string[],
  batchIndex: number,
  batchCount: number
): string {
  return `${buildCaseBrief(data.type, data.title, data.description, data.context, players)}

## Фрейм игры
${caseFrame || "Не указан"}

## Core players
${formatPlayersForPrompt(players)}

## Aggregated actors
${aggregatedActors.length ? aggregatedActors.join("\n") : "Нет"}

## Assumptions
${assumptions.length ? assumptions.join("\n") : "Нет дополнительных assumptions"}

## Batch
Пачка ${batchIndex + 1} из ${batchCount}. Оцени только перечисленные ниже profiles.

## Strategy profiles to score
${formatProfilesForPrompt(profiles, players)}

Верни payoffs только для этих profile_id.`;
}

function buildPayoffSynthesisUserPrompt(
  data: { type: string; title: string; description: string; context: string },
  players: Player[],
  assumptions: string[],
  caseFrame: string,
  aggregatedActors: string[],
  profiles: StrategyProfile[]
): string {
  return `${buildCompactCaseBrief(data.type, data.title, data.description, data.context)}

## Фрейм игры
${caseFrame || "Не указан"}

## Core players
${formatPlayersForPrompt(players)}

## Aggregated actors
${aggregatedActors.length ? aggregatedActors.join("\n") : "Нет"}

## Assumptions
${assumptions.length ? assumptions.join("\n") : "Нет дополнительных assumptions"}

## Already scored profiles
${formatScoredProfilesForSynthesis(profiles, players)}

Собери только интерпретацию игры и confidence. Не меняй payoffs.`;
}

async function requestJson<T>(
  client: OpenAI,
  analysisId: number,
  model: string,
  phase: AnalysisProgressPhase,
  phaseLabel: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  progressOptions: RequestJsonProgressOptions = {}
): Promise<T> {
  const runtimeConfig = getRuntimeLlmConfig(analysisId);
  const baseURL = runtimeConfig.baseURL;
  const isLmStudio = isLmStudioBaseUrl(baseURL);
  const timeoutMs = runtimeConfig.timeoutMs;
  const profileCount =
    typeof progressOptions.profileCount === "number" && progressOptions.profileCount > 0
      ? progressOptions.profileCount
      : null;
  const profileProcessedOffset = profileCount
    ? clamp(Math.round(progressOptions.profileProcessedCount ?? 0), 0, profileCount)
    : 0;
  const profileIds = progressOptions.profileIds?.filter(Boolean) || [];
  let lastError: unknown;
  let requestModel = analysisRuntimeModels.get(analysisId) || model;
  const maxAttempts = progressOptions.maxAttempts ?? (isLmStudio ? 4 : 2);

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    throwIfAborted(signal);
    try {
      const attemptLabel = attemptIndex === 0 ? phaseLabel : `${phaseLabel} · retry ${attemptIndex + 1}`;
      const shouldStream = progressOptions.stream ?? (!isLmStudio || attemptIndex === 0);
      const retryLanguageInstruction = attemptIndex > 0
        ? "\n\nПОВТОРНАЯ ПОПЫТКА: предыдущий JSON был отклонён из-за английского текста или невалидного формата. Сейчас верни тот же тип JSON, но все человекочитаемые значения строго на русском языке."
        : "";
      appendPhaseHeader(analysisId, attemptLabel);
      updateLiveProgress(analysisId, {
        phase,
        phaseLabel,
        llmStatus:
          attemptIndex === 0
            ? "Ждём первые токены от модели…"
            : shouldStream
              ? "Повторяем запрос после невалидного или неполного ответа модели."
              : "Повторяем запрос без потоковой передачи, чтобы обойти сбой LM Studio.",
        error: null,
        ...(profileCount ? { profileCount, profileProcessedCount: profileProcessedOffset } : {}),
      });

      const request: Record<string, unknown> = {
        model: requestModel,
        messages: [
          {
            role: "system",
            content: isLmStudio
              ? `${systemPrompt}\n\n${RUSSIAN_JSON_CONTRACT}\n\nКРИТИЧНО: верни один валидный JSON-объект без markdown, без префиксов и без пояснений до или после JSON.${retryLanguageInstruction}`
              : `${systemPrompt}\n\n${RUSSIAN_JSON_CONTRACT}${retryLanguageInstruction}`,
          },
          {
            role: "user",
            content: `${userPrompt}\n\nПеред отправкой JSON проверь: все текстовые значения должны быть на русском языке. Английские сегменты, роли, выводы и метрики переведи на русский.`,
          },
        ],
        temperature: runtimeConfig.temperature ?? 0.2,
        stream: shouldStream,
      };

      if (runtimeConfig.maxOutputTokens) {
        request.max_tokens = runtimeConfig.maxOutputTokens;
      }

      if (isLmStudio) {
        request.ttl = getLmStudioTtlSeconds();
      }

      if (!isLmStudio) {
        request.response_format = { type: "json_object" };
      }

      const queuedResult = await runQueuedLlmTask(
        analysisId,
        phase,
        phaseLabel,
        signal,
        async () => {
          let content = "";
          let sawToken = false;
          let finishReason = "";
          let profileProcessedCount = profileProcessedOffset;

          if (shouldStream) {
            const responseStream = await client.chat.completions.create(
              request as never,
              { timeout: timeoutMs, signal },
            ) as unknown as AsyncIterable<any>;

            for await (const chunk of responseStream) {
              throwIfAborted(signal);
              const choice = chunk?.choices?.[0];
              const delta = choice?.delta ?? {};
              const contentChunk = extractChunkText(delta.content);
              const reasoningChunk = extractChunkText((delta as { reasoning_content?: unknown }).reasoning_content);
              const streamChunk = `${reasoningChunk}${contentChunk}`;

              if (streamChunk && !sawToken) {
                sawToken = true;
                updateLiveProgress(analysisId, {
                  phase,
                  phaseLabel,
                  llmStatus: "Модель начала отвечать…",
                });
              }

              if (contentChunk) {
                content += contentChunk;
                if (profileCount) {
                  profileProcessedCount = Math.min(
                    profileCount,
                    profileProcessedOffset + countScoredProfilesFromText(content, profileCount, profileIds),
                  );
                }
              }

              if (streamChunk) {
                appendLivePreview(analysisId, streamChunk, {
                  phase,
                  phaseLabel,
                  llmStatus: "Стримим ответ модели…",
                  ...(profileCount ? { profileCount, profileProcessedCount } : {}),
                });
              }

              if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
                finishReason = choice.finish_reason;
              }
            }
          } else {
            const response = await client.chat.completions.create(
              request as never,
              { timeout: timeoutMs, signal },
            ) as any;
            const choice = response?.choices?.[0];
            const message = choice?.message ?? {};
            const contentChunk = extractChunkText(message.content);
            const reasoningChunk = extractChunkText(message.reasoning_content);
            const previewChunk = `${reasoningChunk}${contentChunk}`;

            if (previewChunk) {
              sawToken = true;
              content += contentChunk;
              if (profileCount) {
                const countedProfiles = countScoredProfilesFromText(content, profileCount, profileIds);
                profileProcessedCount = Math.min(
                  profileCount,
                  profileProcessedOffset + (countedProfiles || profileIds.length || profileCount),
                );
              }
              appendLivePreview(analysisId, previewChunk, {
                phase,
                phaseLabel,
                llmStatus: "Ответ получен без потоковой передачи…",
                ...(profileCount ? { profileCount, profileProcessedCount } : {}),
              });
            }

            if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
              finishReason = choice.finish_reason;
            }
          }

          return { content, finishReason, profileProcessedCount };
        },
      );
      const { content, finishReason } = queuedResult;
      const profileProcessedCount = profileCount
        ? Math.min(
            profileCount,
            Math.max(
              queuedResult.profileProcessedCount,
              profileProcessedOffset + (profileIds.length || profileCount),
            ),
          )
        : 0;

      if (!content.trim()) {
        throw new Error("LLM returned empty content");
      }

      updateLiveProgress(analysisId, {
        phase,
        phaseLabel,
        llmStatus:
          finishReason === "length"
            ? "Модель завершила ответ, проверяем JSON и при необходимости повторим запрос…"
            : "Ответ получен, проверяем JSON…",
        ...(profileCount ? { profileCount, profileProcessedCount } : {}),
      });

      const parsed = parseJsonFromCompletion<T>(content);
      assertJsonTextIsRussian(parsed);
      return parsed;
    } catch (error) {
      if (signal?.aborted || isAbortLikeError(error)) {
        throw new AnalysisCancelledError();
      }

      lastError = error;
      const errorMessage = getErrorMessage(error);
      const needsModelCheck = isLmStudio && isLmStudioModelNeedsUserCheckError(error);

      if (needsModelCheck) {
        requestModel = await waitForUserLlmCheck(
          analysisId,
          phase,
          phaseLabel,
          errorMessage,
          signal,
        );
        attemptIndex -= 1;
        continue;
      }

      const hasRetryLeft = attemptIndex < maxAttempts - 1;

      appendLivePreview(
        analysisId,
        `\n\n[${phaseLabel}] ${hasRetryLeft ? "Попытка не удалась" : "Ошибка"}: ${errorMessage}\n`,
        {
          phase,
          phaseLabel,
          llmStatus: hasRetryLeft
            ? isLmStudio
              ? "Пробуем ещё раз без потоковой передачи…"
              : "Пробуем ещё раз…"
            : errorMessage,
          error: hasRetryLeft ? null : errorMessage,
        },
        false,
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error("LLM returned invalid JSON");
}

async function requestText(
  client: OpenAI,
  analysisId: number,
  model: string,
  phase: AnalysisProgressPhase,
  phaseLabel: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal
): Promise<string> {
  const runtimeConfig = getRuntimeLlmConfig(analysisId);
  const baseURL = runtimeConfig.baseURL;
  const isLmStudio = isLmStudioBaseUrl(baseURL);
  const timeoutMs = runtimeConfig.timeoutMs;
  let lastError: unknown;
  let requestModel = analysisRuntimeModels.get(analysisId) || model;
  const maxAttempts = isLmStudio ? 4 : 2;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    throwIfAborted(signal);
    try {
      const attemptLabel = attemptIndex === 0 ? phaseLabel : `${phaseLabel} · retry ${attemptIndex + 1}`;
      const shouldStream = !isLmStudio || attemptIndex === 0;
      appendPhaseHeader(analysisId, attemptLabel);
      updateLiveProgress(analysisId, {
        phase,
        phaseLabel,
        llmStatus:
          attemptIndex === 0
            ? "Ждём первые токены от модели…"
            : shouldStream
              ? "Повторяем запрос после пустого ответа модели."
              : "Повторяем запрос без потоковой передачи, чтобы обойти сбой LM Studio.",
        error: null,
      });

      const request: Record<string, unknown> = {
        model: requestModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: runtimeConfig.temperature ?? 0.35,
        stream: shouldStream,
      };

      if (runtimeConfig.maxOutputTokens) {
        request.max_tokens = runtimeConfig.maxOutputTokens;
      }

      if (isLmStudio) {
        request.ttl = getLmStudioTtlSeconds();
      }

      const content = await runQueuedLlmTask(
        analysisId,
        phase,
        phaseLabel,
        signal,
        async () => {
          let content = "";
          let sawToken = false;

          if (shouldStream) {
            const responseStream = await client.chat.completions.create(
              request as never,
              { timeout: timeoutMs, signal },
            ) as unknown as AsyncIterable<any>;

            for await (const chunk of responseStream) {
              throwIfAborted(signal);
              const choice = chunk?.choices?.[0];
              const delta = choice?.delta ?? {};
              const contentChunk = extractChunkText(delta.content);

              if (contentChunk && !sawToken) {
                sawToken = true;
                updateLiveProgress(analysisId, {
                  phase,
                  phaseLabel,
                  llmStatus: "Модель начала отвечать…",
                });
              }

              if (contentChunk) {
                content += contentChunk;
                appendLivePreview(analysisId, contentChunk, {
                  phase,
                  phaseLabel,
                  llmStatus: "Стримим статью для развёрнутого анализа…",
                });
              }
            }
          } else {
            const response = await client.chat.completions.create(
              request as never,
              { timeout: timeoutMs, signal },
            ) as any;
            const contentChunk = extractChunkText(response?.choices?.[0]?.message?.content);

            if (contentChunk) {
              content += contentChunk;
              appendLivePreview(analysisId, contentChunk, {
                phase,
                phaseLabel,
                llmStatus: "Ответ получен без потоковой передачи…",
              });
            }
          }

          return content;
        },
      );

      if (!content.trim()) {
        throw new Error("LLM returned empty content");
      }

      updateLiveProgress(analysisId, {
        phase,
        phaseLabel,
        llmStatus: "Статья получена.",
      });

      return content.trim();
    } catch (error) {
      if (signal?.aborted || isAbortLikeError(error)) {
        throw new AnalysisCancelledError();
      }

      lastError = error;
      const errorMessage = getErrorMessage(error);
      const needsModelCheck = isLmStudio && isLmStudioModelNeedsUserCheckError(error);

      if (needsModelCheck) {
        requestModel = await waitForUserLlmCheck(
          analysisId,
          phase,
          phaseLabel,
          errorMessage,
          signal,
        );
        attemptIndex -= 1;
        continue;
      }

      const hasRetryLeft = attemptIndex < maxAttempts - 1;

      appendLivePreview(
        analysisId,
        `\n\n[${phaseLabel}] ${hasRetryLeft ? "Попытка не удалась" : "Ошибка"}: ${errorMessage}\n`,
        {
          phase,
          phaseLabel,
          llmStatus: hasRetryLeft
            ? isLmStudio
              ? "Пробуем ещё раз без потоковой передачи…"
              : "Пробуем ещё раз…"
            : errorMessage,
          error: hasRetryLeft ? null : errorMessage,
        },
        false,
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error("LLM returned empty text");
}

function getConfiguredBaseUrl(): string {
  return getActiveLlmConfig().baseURL;
}

function getConfiguredTimeoutMs(baseURL: string): number {
  const active = getActiveLlmConfig();
  if (active.baseURL === baseURL) {
    return active.timeoutMs;
  }

  const configured = Number.parseInt(process.env.LLM_TIMEOUT_MS || "", 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return isLmStudioBaseUrl(baseURL) ? 15 * 60 * 1000 : 2 * 60 * 1000;
}

function getLmStudioTtlSeconds(): number {
  const configured = Number.parseInt(process.env.LM_STUDIO_TTL_SECONDS || "", 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return 24 * 60 * 60;
}

function getProfileBatchSize(): number {
  const configured = Number.parseInt(process.env.LLM_PROFILE_BATCH_SIZE || "", 10);
  if (Number.isFinite(configured) && configured > 0) {
    return clamp(configured, 1, MAX_PROFILE_BUDGET);
  }

  return DEFAULT_PROFILE_BATCH_SIZE;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function isLmStudioBaseUrl(baseURL: string): boolean {
  const normalized = baseURL.toLowerCase();
  return normalized.includes("127.0.0.1:1234") || normalized.includes("localhost:1234") || normalized.includes("lmstudio");
}

function isLmStudioModelReloadedError(error: unknown): boolean {
  return /model reloaded/i.test(getErrorMessage(error));
}

function isLmStudioModelNeedsUserCheckError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return (
    isLmStudioModelReloadedError(error) ||
    /model has crashed/i.test(message) ||
    /model is unloaded/i.test(message) ||
    /cannot find model of instance reference/i.test(message) ||
    /compute error/i.test(message) ||
    /no loaded model/i.test(message)
  );
}

function extractChunkText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => extractChunkText(item)).join("");
  }

  if (value && typeof value === "object") {
    if (typeof (value as { text?: unknown }).text === "string") {
      return (value as { text: string }).text;
    }

    if (Array.isArray((value as { parts?: unknown[] }).parts)) {
      return (value as { parts: unknown[] }).parts.map((item) => extractChunkText(item)).join("");
    }
  }

  return "";
}

async function resolveConfiguredModel(config: ProviderSettings & { provider: LlmProvider }, signal?: AbortSignal): Promise<string> {
  const preferredModel = config.model?.trim();
  if (preferredModel && preferredModel.toLowerCase() !== "auto") {
    return preferredModel;
  }

  const loadedLmStudioModel = await resolveLoadedLmStudioModel(config.baseURL, config.apiKey || "lm-studio", signal);
  if (loadedLmStudioModel) {
    return loadedLmStudioModel;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
  };
  if (config.projectId) {
    headers["OpenAI-Project"] = config.projectId;
  }

  const response = await fetch(`${config.baseURL.replace(/\/+$/, "")}/models`, {
    headers: {
      ...headers,
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to list models from configured LLM endpoint (${response.status})`);
  }

  const payload = (await response.json()) as { data?: Array<{ id?: string }> };
  const modelId = payload.data?.find((item) => typeof item?.id === "string" && item.id.trim())?.id?.trim();

  if (!modelId) {
    throw new Error("No models available on configured LLM endpoint");
  }

  return modelId;
}

async function resolveLoadedLmStudioModel(
  baseURL: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (!isLmStudioBaseUrl(baseURL)) {
    return null;
  }

  const origin = new URL(baseURL).origin;
  const v0Model = await resolveLoadedLmStudioModelFromV0(origin, apiKey, signal);
  if (v0Model) {
    return v0Model;
  }

  const response = await fetch(`${origin}/api/v1/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    models?: Array<{
      key?: string;
      loaded_instances?: Array<{ id?: string }>;
    }>;
  };

  for (const model of payload.models || []) {
    const loadedInstanceId = model.loaded_instances?.find(
      (instance) => typeof instance?.id === "string" && instance.id.trim()
    )?.id;

    if (loadedInstanceId?.trim()) {
      return loadedInstanceId.trim();
    }

    if ((model.loaded_instances?.length || 0) > 0 && model.key?.trim()) {
      return model.key.trim();
    }
  }

  return null;
}

async function resolveLoadedLmStudioModelFromV0(
  origin: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<string | null> {
  const response = await fetch(`${origin}/api/v0/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    data?: Array<{
      id?: string;
      type?: string;
      state?: string;
    }>;
  };

  const loadedModel = payload.data?.find((model) => {
    const type = model?.type?.toLowerCase();
    return (
      typeof model?.id === "string" &&
      model.id.trim() &&
      model.state === "loaded" &&
      type !== "embedding" &&
      type !== "embeddings"
    );
  });

  return loadedModel?.id?.trim() || null;
}

function extractJsonObject(content: string): string | null {
  const start = content.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseJsonFromCompletion<T>(content: string): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    const candidate = extractJsonObject(content);
    if (!candidate) {
      throw new Error("LLM returned invalid JSON");
    }

    return JSON.parse(candidate) as T;
  }
}

const JSON_LANGUAGE_EXEMPT_KEYS = new Set([
  "id",
  "type",
  "weight",
  "feasible",
  "payoffs",
  "confidence",
  "priority",
  "omittedPlayerId",
  "impact",
  "recommendedDecision",
  "targetEquilibrium",
  "targetPlayerId",
  "analysisMode",
  "modelKind",
  "variableId",
  "targetDirection",
  "op",
  "timing",
  "reversibility",
  "kind",
  "severity",
  "dominantRegimeId",
  "effort",
  "expectedNashScoreDelta",
  "expectedPayoffDelta",
]);

const TECHNICAL_JSON_VALUES = new Set([
  "api",
  "sla",
  "ux",
  "ui",
  "json",
  "llm",
  "pm",
  "nash",
  "gmv",
  "ltv",
  "nps",
  "a/b",
  "b2b",
  "b2c",
  "p1",
  "p2",
  "p3",
  "p4",
  "p5",
  "system",
  "launch",
  "revise",
  "pause",
  "kill",
  "low",
  "medium",
  "high",
  "critical",
  "stable",
  "unstable",
  "conditional",
  "complexity",
  "bounded_adaptive_simulation",
  "baseline",
  "upside",
  "stress",
  "team",
  "reinforcing",
  "balancing",
  "up",
  "down",
  "range",
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
  "prelaunch",
  "postlaunch",
  "easy",
  "moderate",
  "hard",
  "growth",
  "stall",
  "lock_in",
  "cascade",
  "overload",
  "commoditization",
  "recovery",
  "competitor",
  "partner",
  "regulator",
  "user",
  "platform",
  "other",
]);

const ENGLISH_LANGUAGE_MARKERS = new Set([
  "the",
  "and",
  "for",
  "with",
  "without",
  "will",
  "would",
  "should",
  "could",
  "only",
  "more",
  "less",
  "from",
  "into",
  "over",
  "under",
  "between",
  "because",
  "depends",
  "requires",
  "creates",
  "provides",
  "introduces",
  "chooses",
  "decide",
  "evaluate",
  "manage",
  "boost",
  "feature",
  "gift",
  "buyers",
  "buyer",
  "sellers",
  "seller",
  "admins",
  "admin",
  "marketplaces",
  "competing",
  "logistics",
  "providers",
  "regulatory",
  "bodies",
  "support",
  "ticket",
  "volume",
  "conversion",
  "uplift",
  "optimal",
  "equilibrium",
  "engagement",
  "disengagement",
  "participation",
  "stability",
  "platform",
]);

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length || 0;
}

function getJsonPathKey(path: string): string {
  const match = path.match(/(?:^|\.)([^.[\]]+)(?:\[\d+\])?$/);
  return match?.[1] || path;
}

function shouldCheckRussianJsonString(path: string, value: string): boolean {
  const key = getJsonPathKey(path);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 4 || JSON_LANGUAGE_EXEMPT_KEYS.has(key)) {
    return false;
  }

  if (/^profile_\d+$/i.test(trimmed) || /^p\d+$/i.test(trimmed)) {
    return false;
  }

  return /[A-Za-zА-Яа-яЁё]/.test(trimmed);
}

function getNonTechnicalLatinWords(value: string): string[] {
  const words = value.match(/[A-Za-z][A-Za-z'/-]*/g) || [];

  return words
    .map((word) => word.toLowerCase().replace(/^[-/]+|[-/]+$/g, ""))
    .filter((word) => {
      if (!word || word.length < 3) return false;
      if (TECHNICAL_JSON_VALUES.has(word)) return false;
      if (/^profile_\d+$/.test(word)) return false;
      return true;
    });
}

function looksNonRussianForJson(value: string): boolean {
  const trimmed = value.trim();
  const latinWords = getNonTechnicalLatinWords(trimmed);
  if (latinWords.length === 0) {
    return false;
  }

  const cyrillicChars = countMatches(trimmed, /[А-Яа-яЁё]/g);
  if (cyrillicChars === 0) {
    return true;
  }

  const latinChars = countMatches(trimmed, /[A-Za-z]/g);
  const totalLetters = latinChars + cyrillicChars;
  const latinShare = totalLetters > 0 ? latinChars / totalLetters : 0;
  const englishMarkers = latinWords.filter((word) => ENGLISH_LANGUAGE_MARKERS.has(word)).length;

  if (englishMarkers >= 2) {
    return true;
  }

  if (cyrillicChars >= 40 && latinShare < 0.25) {
    return false;
  }

  if (cyrillicChars > latinChars && latinWords.length <= 4) {
    return false;
  }

  return latinWords.length >= 5 ? latinShare > 0.2 : latinShare > 0.45;
}

function collectNonRussianJsonStrings(value: unknown, path = "$", issues: string[] = []): string[] {
  if (typeof value === "string") {
    if (shouldCheckRussianJsonString(path, value) && looksNonRussianForJson(value)) {
      issues.push(`${path}: ${value.slice(0, 120)}`);
    }
    return issues;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectNonRussianJsonStrings(item, `${path}[${index}]`, issues));
    return issues;
  }

  if (value && typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
      collectNonRussianJsonStrings(item, `${path}.${key}`, issues);
    });
  }

  return issues;
}

function assertJsonTextIsRussian(value: unknown): void {
  const issues = collectNonRussianJsonStrings(value).slice(0, 5);
  if (issues.length > 0) {
    throw new Error(
      `JSON содержит английский текст в человекочитаемых полях. Перепиши все текстовые значения на русском языке. Примеры: ${issues.join(" | ")}`
    );
  }
}

function buildStrategyProfiles(players: Player[]): StrategyProfile[] {
  const profiles: StrategyProfile[] = [];

  function walk(index: number, selections: Record<string, string>) {
    if (index === players.length) {
      profiles.push({
        id: `profile_${profiles.length + 1}`,
        selections: { ...selections },
        payoffs: {},
        feasible: true,
        summary: "",
      });
      return;
    }

    const player = players[index];
    for (const strategy of player.strategies) {
      selections[player.id] = strategy;
      walk(index + 1, selections);
    }
  }

  walk(0, {});
  return profiles;
}

function hydrateProfiles(
  baseProfiles: StrategyProfile[],
  assessedProfiles: PayoffPromptProfile[] | undefined,
  players: Player[]
): StrategyProfile[] {
  if (!assessedProfiles || assessedProfiles.length === 0) {
    throw new Error("LLM did not return any scored profiles");
  }

  const assessedById = new Map(
    assessedProfiles
      .filter((profile): profile is Required<Pick<PayoffPromptProfile, "id">> & PayoffPromptProfile => typeof profile.id === "string")
      .map((profile) => [profile.id, profile])
  );

  return baseProfiles.map((profile) => {
    const scored = assessedById.get(profile.id);
    if (!scored) {
      throw new Error(`LLM skipped ${profile.id}`);
    }

    const payoffs = Object.fromEntries(
      players.map((player) => [
        player.id,
        clamp(
          Math.round(
            typeof scored.payoffs?.[player.id] === "number"
              ? scored.payoffs[player.id] as number
              : 0
          ),
          -10,
          10
        ),
      ])
    );

    return {
      ...profile,
      payoffs,
      feasible: scored.feasible !== false,
      summary: scored.summary?.trim() || "Profile scored by the model.",
    };
  });
}

function profileKey(profile: Record<string, string>, players: Player[]): string {
  return players.map((player) => `${player.id}:${profile[player.id]}`).join("|");
}

function buildDeviationChecks(
  profile: StrategyProfile,
  profilesByKey: Map<string, StrategyProfile>,
  players: Player[]
): DeviationCheck[] {
  const deviations: DeviationCheck[] = [];

  for (const player of players) {
    const currentStrategy = profile.selections[player.id];
    for (const strategy of player.strategies) {
      if (strategy === currentStrategy) {
        continue;
      }

      const deviatedSelections = { ...profile.selections, [player.id]: strategy };
      const deviatedProfile = profilesByKey.get(profileKey(deviatedSelections, players));
      if (!deviatedProfile) {
        continue;
      }

      const payoffDelta = (deviatedProfile.payoffs[player.id] ?? 0) - (profile.payoffs[player.id] ?? 0);
      deviations.push({
        playerId: player.id,
        fromStrategy: currentStrategy,
        toStrategy: strategy,
        payoffDelta,
        profitable: payoffDelta > 0,
      });
    }
  }

  return deviations;
}

function deriveStability(deviations: DeviationCheck[]): NashScenario["stability"] {
  if (deviations.some((deviation) => deviation.profitable)) {
    return "unstable";
  }

  const moat = deviations.length > 0 ? Math.min(...deviations.map((deviation) => -deviation.payoffDelta)) : 0;
  if (moat >= 2) {
    return "stable";
  }

  return "conditional";
}

function scoreScenario(
  scenario: NashScenario,
  players: Player[],
  confidence: number,
  nashCount: number
): number {
  const focalPlayerId = players[0]?.id;
  const totalWeight = players.reduce((sum, player) => sum + (player.weight ?? 1), 0) || 1;
  const weightedAverage =
    players.reduce(
      (sum, player) => sum + (scenario.payoffs[player.id] ?? 0) * (player.weight ?? 1),
      0
    ) / totalWeight;
  const focalPayoff = focalPlayerId ? scenario.payoffs[focalPlayerId] ?? 0 : weightedAverage;
  const moat =
    scenario.deviations && scenario.deviations.length > 0
      ? Math.min(...scenario.deviations.map((deviation) => -deviation.payoffDelta))
      : 0;

  return clamp(
    Math.round(
      40 +
        focalPayoff * 2.5 +
        weightedAverage * 1.5 +
        moat * 8 +
        (confidence - 50) * 0.25 +
        (nashCount === 0 ? -15 : 0) +
        (nashCount > 1 ? -4 : 0)
    ),
    0,
    100
  );
}

function deriveRiskLevel(score: number, confidence: number, isExactNash: boolean): AnalysisResult["riskLevel"] {
  if (score >= 80 && confidence >= 60 && isExactNash) {
    return "low";
  }
  if (score >= 60 && confidence >= 50) {
    return "medium";
  }
  if (score >= 40) {
    return "high";
  }
  return "critical";
}

function deriveVerdict(score: number, confidence: number, isExactNash: boolean): AnalysisResult["verdict"] {
  if (score >= 80 && confidence >= 60 && isExactNash) {
    return "launch";
  }
  if (score >= 60) {
    return "revise";
  }
  if (score >= 40) {
    return "pause";
  }
  return "kill";
}

function analyzeProfiles(
  players: Player[],
  profiles: StrategyProfile[],
  confidence: number
): {
  equilibria: NashScenario[];
  recommendedEquilibrium: NashScenario | null;
  nashScore: number;
  riskLevel: AnalysisResult["riskLevel"];
  verdict: AnalysisResult["verdict"];
} {
  const profilesByKey = new Map(profiles.map((profile) => [profileKey(profile.selections, players), profile]));

  const evaluated = profiles.map((profile) => {
    const deviations = buildDeviationChecks(profile, profilesByKey, players);
    const isNash = profile.feasible && deviations.every((deviation) => !deviation.profitable);
    const stability = deriveStability(deviations);
    const description = isNash
      ? `${profile.summary} Это ${stability === "stable" ? "устойчивое" : "условное"} Nash-равновесие для текущего состава игроков.`
      : `${profile.summary} У этого профиля есть выгодные односторонние отклонения, поэтому он не удерживается как Nash-равновесие.`;

    const scenario: NashScenario = {
      profileId: profile.id,
      strategies: profile.selections,
      payoffs: profile.payoffs,
      isNash,
      stability,
      description,
      deviations,
    };

    const profitableCount = deviations.filter((deviation) => deviation.profitable).length;
    const maxGain = deviations.reduce(
      (best, deviation) => (deviation.profitable ? Math.max(best, deviation.payoffDelta) : best),
      0
    );

    return {
      scenario,
      profitableCount,
      maxGain,
      focalPayoff: profile.payoffs[players[0]?.id ?? ""] ?? 0,
    };
  });

  const exactEquilibria = evaluated.filter((item) => item.scenario.isNash).map((item) => item.scenario);

  let recommended: NashScenario | null =
    exactEquilibria
      .slice()
      .sort(
        (left, right) =>
          scoreScenario(right, players, confidence, exactEquilibria.length) -
          scoreScenario(left, players, confidence, exactEquilibria.length)
      )
      .at(0) ?? null;

  if (!recommended) {
    const bestApproximation = evaluated
      .slice()
      .sort((left, right) => left.maxGain - right.maxGain || right.focalPayoff - left.focalPayoff)
      .at(0);

    recommended = bestApproximation
      ? {
          ...bestApproximation.scenario,
          description: `${bestApproximation.scenario.description} Точного Nash-равновесия не найдено, поэтому это best-effort профиль с минимальным стимулом к отклонению.`,
        }
      : null;
  }

  const nashScore = recommended ? scoreScenario(recommended, players, confidence, exactEquilibria.length) : 0;
  const riskLevel = deriveRiskLevel(nashScore, confidence, Boolean(recommended?.isNash));
  const verdict = deriveVerdict(nashScore, confidence, Boolean(recommended?.isNash));

  return {
    equilibria: exactEquilibria.length > 0 ? exactEquilibria : recommended ? [recommended] : [],
    recommendedEquilibrium: recommended,
    nashScore,
    riskLevel,
    verdict,
  };
}

function buildPairwiseView(
  playerA: Player,
  playerB: Player,
  players: Player[],
  profilesByKey: Map<string, StrategyProfile>,
  fixedSelections: Record<string, string>
): PairwiseView {
  const matrix = playerA.strategies.map((strategyA) =>
    playerB.strategies.map((strategyB) => {
      const selections = {
        ...fixedSelections,
        [playerA.id]: strategyA,
        [playerB.id]: strategyB,
      };

      const profile = profilesByKey.get(profileKey(selections, players));
      return profile
        ? {
            strategies: profile.selections,
            payoffs: profile.payoffs,
            isNash: false,
          }
        : {
            strategies: selections,
            payoffs: {},
            isNash: false,
          };
    })
  );

  return {
    players: [playerA.id, playerB.id],
    matrix,
    matrixStrategies: {
      [playerA.id]: playerA.strategies,
      [playerB.id]: playerB.strategies,
    },
  };
}

function buildPairwiseViews(
  players: Player[],
  profiles: StrategyProfile[],
  equilibria: NashScenario[],
  recommended: NashScenario | null
): PairwiseView[] {
  if (players.length < 2) {
    return [];
  }

  const profilesByKey = new Map(profiles.map((profile) => [profileKey(profile.selections, players), profile]));
  const nashKeys = new Set(
    equilibria.filter((scenario) => scenario.isNash).map((scenario) => profileKey(scenario.strategies, players))
  );
  const fixedSelections = recommended?.strategies || profiles[0]?.selections || {};
  const focal = players[0];
  const candidatePairs = players.length === 2 ? [[players[0], players[1]]] : players.slice(1).map((player) => [focal, player] as const);

  return candidatePairs.map(([playerA, playerB]) => {
    const view = buildPairwiseView(playerA, playerB, players, profilesByKey, fixedSelections);
    view.matrix = view.matrix.map((row) =>
      row.map((cell) => ({
        ...cell,
        isNash: nashKeys.has(profileKey(cell.strategies, players)),
      }))
    );
    return view;
  });
}

function normalizeSensitivityChecks(value: unknown): SensitivityCheck[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const omittedPlayerId =
        typeof item === "object" && item !== null && typeof (item as SensitivityCheck).omittedPlayerId === "string"
          ? (item as SensitivityCheck).omittedPlayerId
          : "unknown";
      const impact =
        typeof item === "object" && item !== null && typeof (item as SensitivityCheck).impact === "string"
          ? (item as SensitivityCheck).impact
          : "medium";
      const note =
        typeof item === "object" && item !== null && typeof (item as SensitivityCheck).note === "string"
          ? (item as SensitivityCheck).note.trim()
          : "";

      return {
        omittedPlayerId,
        impact: impact === "low" || impact === "medium" || impact === "high" ? impact : "medium",
        note,
      } satisfies SensitivityCheck;
    })
    .filter((item) => item.note);
}

function normalizeDecision(value: unknown, fallback: ProductDecision): ProductDecision {
  switch (value) {
    case "launch":
    case "revise":
    case "pause":
    case "kill":
      return value;
    default:
      return fallback;
  }
}

function normalizeDecisionText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeDecisionTarget(value: unknown, fallback: string | null): string | null {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") {
    return null;
  }

  return trimmed;
}

function normalizeEffort(value: unknown, fallback: StrategicMove["effort"]): StrategicMove["effort"] {
  return value === "S" || value === "M" || value === "L" ? value : fallback;
}

function normalizeExpectedPayoffDelta(
  value: unknown,
  players: Player[],
  fallback: Record<string, number>
): Record<string, number> {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};

  return Object.fromEntries(
    players.map((player) => {
      const nextValue = raw[player.id];
      const fallbackValue = fallback[player.id] ?? 0;
      return [
        player.id,
        clamp(
          Math.round(typeof nextValue === "number" ? nextValue : fallbackValue),
          -10,
          10
        ),
      ];
    })
  );
}

function normalizeStrategicMoves(
  value: unknown,
  players: Player[],
  fallback: StrategicMove[]
): StrategicMove[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const validTargetIds = new Set([...players.map((player) => player.id), "system"]);
  const fallbackByIndex = fallback.length > 0 ? fallback : [];

  const moves = value
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const raw = item as DecisionPackPromptMove;
      const fallbackMove = fallbackByIndex[index] || fallbackByIndex[0];
      const title = normalizeDecisionText(raw.title, fallbackMove?.title || "");
      const objective = normalizeDecisionText(raw.objective, fallbackMove?.objective || "");
      const changesIncentiveHow = normalizeDecisionText(
        raw.changesIncentiveHow,
        fallbackMove?.changesIncentiveHow || ""
      );

      if (!title || !objective || !changesIncentiveHow) {
        return null;
      }

      const candidateTarget = typeof raw.targetPlayerId === "string" ? raw.targetPlayerId.trim() : "";
      const targetPlayerId = validTargetIds.has(candidateTarget)
        ? candidateTarget
        : fallbackMove?.targetPlayerId || "system";

      return {
        title,
        objective,
        targetPlayerId,
        changesIncentiveHow,
        expectedNashScoreDelta: clamp(
          Math.round(
            typeof raw.expectedNashScoreDelta === "number"
              ? raw.expectedNashScoreDelta
              : fallbackMove?.expectedNashScoreDelta ?? 0
          ),
          -40,
          40
        ),
        expectedPayoffDelta: normalizeExpectedPayoffDelta(
          raw.expectedPayoffDelta,
          players,
          fallbackMove?.expectedPayoffDelta || {}
        ),
        effort: normalizeEffort(raw.effort, fallbackMove?.effort || "M"),
        confidence: clamp(
          Math.round(typeof raw.confidence === "number" ? raw.confidence : fallbackMove?.confidence ?? 50),
          0,
          100
        ),
        priority: clamp(
          Math.round(typeof raw.priority === "number" ? raw.priority : fallbackMove?.priority ?? index + 1),
          1,
          99
        ),
      } satisfies StrategicMove;
    })
    .filter((move): move is StrategicMove => Boolean(move))
    .sort((left, right) => left.priority - right.priority)
    .slice(0, 5);

  return moves.length > 0 ? moves : fallback;
}

function normalizeExperimentPlan(
  value: unknown,
  fallback: ExperimentPlanItem[]
): ExperimentPlanItem[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const items = value
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const raw = item as DecisionPackPromptExperiment;
      const fallbackItem = fallback[index] || fallback[0];
      const experiment = {
        hypothesis: normalizeDecisionText(raw.hypothesis, fallbackItem?.hypothesis || ""),
        metric: normalizeDecisionText(raw.metric, fallbackItem?.metric || ""),
        guardrailMetric: normalizeDecisionText(raw.guardrailMetric, fallbackItem?.guardrailMetric || ""),
        successCriterion: normalizeDecisionText(raw.successCriterion, fallbackItem?.successCriterion || ""),
        killCriterion: normalizeDecisionText(raw.killCriterion, fallbackItem?.killCriterion || ""),
        timebox: normalizeDecisionText(raw.timebox, fallbackItem?.timebox || ""),
      } satisfies ExperimentPlanItem;

      return experiment.hypothesis && experiment.metric && experiment.successCriterion
        ? experiment
        : null;
    })
    .filter((item): item is ExperimentPlanItem => Boolean(item))
    .slice(0, 5);

  return items.length > 0 ? items : fallback;
}

function normalizeCounterMovePlaybook(
  value: unknown,
  fallback: DecisionPack["counterMovePlaybook"]
): DecisionPack["counterMovePlaybook"] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const items = value
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const raw = item as DecisionPackPromptCounterMove;
      const fallbackItem = fallback[index] || fallback[0];
      const playbookItem = {
        threat: normalizeDecisionText(raw.threat, fallbackItem?.threat || ""),
        earlySignal: normalizeDecisionText(raw.earlySignal, fallbackItem?.earlySignal || ""),
        mitigation: normalizeDecisionText(raw.mitigation, fallbackItem?.mitigation || ""),
      } satisfies CounterMovePlaybookItem;

      return playbookItem.threat && playbookItem.earlySignal && playbookItem.mitigation
        ? playbookItem
        : null;
    })
    .filter((item): item is CounterMovePlaybookItem => Boolean(item))
    .slice(0, 5);

  return items.length > 0 ? items : fallback;
}

function buildDefaultPayoffDelta(
  players: Player[],
  focalDelta: number,
  targetPlayerId = "system"
): Record<string, number> {
  const focalPlayerId = players[0]?.id;

  return Object.fromEntries(
    players.map((player) => [
      player.id,
      player.id === focalPlayerId
        ? focalDelta
        : player.id === targetPlayerId
          ? -1
          : 0,
    ])
  );
}

function buildFallbackDecisionPack(input: {
  title: string;
  type: string;
  players: Player[];
  confidence: number;
  nashScore: number;
  verdict: ProductDecision;
  recommendedEquilibrium: NashScenario | null;
  keyInsights: string[];
  breakEquilibriumMoves: string[];
  recommendations: string[];
  sensitivityChecks: SensitivityCheck[];
}): DecisionPack {
  const focalPlayerId = input.players[0]?.id || "p1";
  const scoreLabel = `Nash score ${input.nashScore}, confidence ${input.confidence}`;
  const primaryInsight = input.keyInsights[0] || "Игра требует управляемого запуска и проверки ключевых стимулов игроков.";
  const recommendedActions = input.recommendations.length > 0
    ? input.recommendations
    : [
        "Запустить ограниченный rollout с заранее заданными guardrails.",
        "Снизить стимул ключевых игроков к разрушению рекомендованного профиля.",
        "Проверить самые хрупкие допущения до масштабирования.",
      ];

  const topStrategicMoves = recommendedActions.slice(0, 3).map((recommendation, index) => {
    const priority = index + 1;
    const delta = [8, 5, 3][index] ?? 2;
    const targetPlayerId = index === 0 ? focalPlayerId : "system";

    return {
      title: index === 0
        ? "Зафиксировать управляемый режим запуска"
        : index === 1
          ? "Снизить выгоду контрхода"
          : "Проверить хрупкое допущение",
      objective: recommendation,
      targetPlayerId,
      changesIncentiveHow: index === 0
        ? "Уменьшает стоимость ошибки для фокальной команды и сохраняет возможность быстро изменить стратегию."
        : "Снижает payoff разрушительного отклонения и делает рекомендованный профиль менее хрупким.",
      expectedNashScoreDelta: delta,
      expectedPayoffDelta: buildDefaultPayoffDelta(input.players, index === 0 ? 2 : 1, targetPlayerId),
      effort: index === 0 ? "M" : "S",
      confidence: clamp(input.confidence - index * 7, 25, 90),
      priority,
    } satisfies StrategicMove;
  });

  const mainMove = topStrategicMoves[0]?.title || "рекомендованный стратегический ход";
  const threatSources = input.breakEquilibriumMoves.length > 0
    ? input.breakEquilibriumMoves
    : input.sensitivityChecks.map((check) => check.note);

  return {
    executiveSummary: `${scoreLabel}. ${primaryInsight}`,
    recommendedDecision: input.verdict,
    whyNow: input.verdict === "launch"
      ? "Позиция выглядит достаточно устойчивой, но масштабирование стоит привязать к guardrails и ранним сигналам контрходов."
      : "Перед масштабированием нужно снять самые дорогие неопределённости и усилить профиль, который агент считает целевым.",
    targetEquilibrium: input.recommendedEquilibrium?.profileId || null,
    topStrategicMoves,
    experimentPlan: [
      {
        hypothesis: `Если выполнить "${mainMove}", рекомендованный профиль станет устойчивее без заметного ухудшения пользовательского эффекта.`,
        metric: "Доля целевого сегмента, дошедшая до ключевого действия",
        guardrailMetric: "Рост негативных сигналов: жалобы, фрод, отказы, операционные инциденты",
        successCriterion: "Основная метрика растёт или удерживается, guardrail-метрика остаётся в допустимом коридоре",
        killCriterion: "Guardrail-метрика выходит за порог или ключевой игрок получает явный стимул к разрушительному отклонению",
        timebox: "2-4 недели",
      },
      {
        hypothesis: "Ранние сигналы контрходов можно обнаружить до того, как они разрушат равновесие.",
        metric: "Количество подтверждённых ранних сигналов по ключевым угрозам",
        guardrailMetric: "Время реакции команды на сигнал",
        successCriterion: "Команда видит сигнал и принимает решение в пределах одного операционного цикла",
        killCriterion: "Сигналы приходят слишком поздно или не связаны с конкретными действиями команды",
        timebox: "1-2 недели мониторинга после старта",
      },
    ],
    launchGuardrails: uniqueStrings([
      "Не масштабировать запуск без заранее заданного порога остановки.",
      "Развести success metric и guardrail metrics, чтобы рост не маскировал разрушение равновесия.",
      ...threatSources.slice(0, 3).map((threat) => `Мониторить: ${threat}`),
    ]).slice(0, 6),
    counterMovePlaybook: threatSources.slice(0, 4).map((threat) => ({
      threat,
      earlySignal: "Изменение поведения игрока, которое повышает его payoff от отклонения.",
      mitigation: "Сузить rollout, усилить guardrail и заранее подготовить ответный ход владельца направления.",
    })),
    openQuestions: uniqueStrings([
      "Какой минимальный объём данных нужен, чтобы подтвердить устойчивость целевого профиля?",
      "Какой игрок первым получает выгоду от отклонения, если условия рынка изменятся?",
      ...input.sensitivityChecks.slice(0, 3).map((check) => `Насколько критичен фактор: ${check.note}`),
    ]).slice(0, 6),
  };
}

function normalizeDecisionPack(raw: DecisionPackResponse, players: Player[], fallback: DecisionPack): DecisionPack {
  return {
    executiveSummary: normalizeDecisionText(raw.executiveSummary, fallback.executiveSummary),
    recommendedDecision: normalizeDecision(raw.recommendedDecision, fallback.recommendedDecision),
    whyNow: normalizeDecisionText(raw.whyNow, fallback.whyNow),
    targetEquilibrium: normalizeDecisionTarget(raw.targetEquilibrium, fallback.targetEquilibrium),
    topStrategicMoves: normalizeStrategicMoves(raw.topStrategicMoves, players, fallback.topStrategicMoves),
    experimentPlan: normalizeExperimentPlan(raw.experimentPlan, fallback.experimentPlan),
    launchGuardrails: normalizeTextList(raw.launchGuardrails, fallback.launchGuardrails).slice(0, 6),
    counterMovePlaybook: normalizeCounterMovePlaybook(raw.counterMovePlaybook, fallback.counterMovePlaybook),
    openQuestions: normalizeTextList(raw.openQuestions, fallback.openQuestions).slice(0, 6),
  };
}

function formatStrategiesForPrompt(scenario: NashScenario | null, players: Player[]): string {
  if (!scenario) {
    return "Точное или приближённое целевое равновесие не найдено.";
  }

  return players
    .map((player) => `${player.id} ${player.name}: ${scenario.strategies[player.id]} (payoff=${scenario.payoffs[player.id] ?? 0})`)
    .join("\n");
}

function formatDeviationsForPrompt(scenario: NashScenario | null, players: Player[]): string {
  if (!scenario?.deviations?.length) {
    return "Нет рассчитанных односторонних отклонений.";
  }

  const playersById = new Map(players.map((player) => [player.id, player.name]));

  return scenario.deviations
    .slice()
    .sort((left, right) => right.payoffDelta - left.payoffDelta)
    .slice(0, 12)
    .map((deviation) => {
      const playerName = playersById.get(deviation.playerId) || deviation.playerId;
      const sign = deviation.payoffDelta >= 0 ? "+" : "";
      return `- ${deviation.playerId} ${playerName}: "${deviation.fromStrategy}" -> "${deviation.toStrategy}", delta=${sign}${deviation.payoffDelta}, profitable=${deviation.profitable}`;
    })
    .join("\n");
}

function formatProfilesForArticlePrompt(profiles: StrategyProfile[], players: Player[]): string {
  return profiles
    .slice(0, 24)
    .map((profile) => {
      const strategies = players
        .map((player) => `${player.name}: ${profile.selections[player.id]}`)
        .join("; ");
      const payoffs = players
        .map((player) => `${player.name}=${profile.payoffs[player.id] ?? 0}`)
        .join(", ");
      return `- ${profile.id}: ${strategies}; выигрыши: ${payoffs}; ${profile.summary}`;
    })
    .join("\n");
}

function formatEquilibriaForArticlePrompt(equilibria: NashScenario[], players: Player[]): string {
  if (!equilibria.length) {
    return "Точных Nash-равновесий не найдено; используй рекомендованный приближённый профиль.";
  }

  return equilibria
    .slice(0, 8)
    .map((equilibrium) => {
      const strategies = players
        .map((player) => `${player.name}: ${equilibrium.strategies[player.id]} (${equilibrium.payoffs[player.id] ?? 0})`)
        .join("; ");
      return `- ${equilibrium.profileId || "profile"}: ${equilibrium.stability}; ${strategies}; ${equilibrium.description}`;
    })
    .join("\n");
}

function buildAgentArticleUserPrompt(
  data: { type: string; title: string; description: string; context: string },
  players: Player[],
  assumptions: string[],
  aggregatedActors: string[],
  gameAnalysis: {
    equilibria: NashScenario[];
    recommendedEquilibrium: NashScenario | null;
    nashScore: number;
    riskLevel: AnalysisResult["riskLevel"];
    verdict: ProductDecision;
  },
  payoffAssessment: {
    profiles: StrategyProfile[];
    confidence: number;
    gameType: string;
    keyInsights: string[];
    breakEquilibriumMoves: string[];
    recommendations: string[];
    sensitivityChecks: SensitivityCheck[];
  }
): string {
  const playersText = players
    .map(
      (player) =>
        `- ${player.id}: ${player.name} [${player.type}], weight=${player.weight}, incentives=${player.incentives}, strategies=[${player.strategies.join(", ")}]`
    )
    .join("\n");
  const sensitivityText = payoffAssessment.sensitivityChecks.length
    ? payoffAssessment.sensitivityChecks
        .map((check) => `- ${check.omittedPlayerId}: impact=${check.impact}; ${check.note}`)
        .join("\n")
    : "Нет";

  return `${buildCaseBrief(data.type, data.title, data.description, data.context, players)}

## Итог Nash-модели
Тип игры: ${payoffAssessment.gameType || "Не указан"}
Вердикт: ${gameAnalysis.verdict}
Риск: ${gameAnalysis.riskLevel}
Nash score: ${gameAnalysis.nashScore}
Достоверность: ${payoffAssessment.confidence}

## Игроки и стратегии
${playersText}

## Рассчитанные профили стратегий
${formatProfilesForArticlePrompt(payoffAssessment.profiles, players)}

## Равновесия Нэша
${formatEquilibriaForArticlePrompt(gameAnalysis.equilibria, players)}

## Рекомендованное равновесие
${formatStrategiesForPrompt(gameAnalysis.recommendedEquilibrium, players)}

## Односторонние отклонения от рекомендованного равновесия
${formatDeviationsForPrompt(gameAnalysis.recommendedEquilibrium, players)}

## Ключевые инсайты
${payoffAssessment.keyInsights.length ? payoffAssessment.keyInsights.join("\n") : "Нет"}

## Угрозы нарушения равновесия
${payoffAssessment.breakEquilibriumMoves.length ? payoffAssessment.breakEquilibriumMoves.join("\n") : "Нет"}

## Рекомендации
${payoffAssessment.recommendations.length ? payoffAssessment.recommendations.join("\n") : "Нет"}

## Проверки чувствительности
${sensitivityText}

## Агрегированные акторы
${aggregatedActors.length ? aggregatedActors.join("\n") : "Нет"}

## Допущения
${assumptions.length ? assumptions.join("\n") : "Нет"}

Напиши только статью для раздела «Развёрнутый анализ агента».`;
}

function buildIntegratedArticleUserPrompt(
  data: { type: string; title: string; description: string; context: string },
  result: IntegratedAnalysisResult,
): string {
  const recommended = result.nash.recommendedEquilibrium;
  const playersById = new Map((result.nash.playersUsed || []).map((player) => [player.id, player]));
  const recommendedStrategies = recommended
    ? Object.entries(recommended.strategies || {})
        .map(([playerId, strategy]) => {
          const player = playersById.get(playerId);
          const payoff = recommended.payoffs?.[playerId];
          return `${player?.name || playerId}: ${strategy}${typeof payoff === "number" ? ` (${payoff})` : ""}`;
        })
        .join("; ")
    : "рекомендованный профиль не найден";
  const compact = {
    finalDecision: result.decisionLabel,
    finalRecommendation: result.finalRecommendation,
    executiveSummary: result.executiveSummary,
    metrics: {
      staticStabilityScore: result.staticStabilityScore,
      dynamicStabilityScore: result.dynamicStabilityScore,
      reachabilityOfNash: result.reachabilityOfNash,
      adaptationPressure: result.adaptationPressure,
      basinOfAttraction: result.basinOfAttraction,
      agreementLevel: result.agreementLevel,
      convergenceExpectation: result.convergenceExpectation,
      confidence: result.confidence,
    },
    nashLayer: {
      nashScore: result.nash.nashScore,
      riskLevel: result.nash.riskLevel,
      verdict: result.nash.verdict,
      gameType: result.nash.gameType,
      players: result.nash.playersUsed.map((player) => ({
        name: player.name,
        type: player.type,
        weight: player.weight,
        incentives: player.incentives,
        strategies: player.strategies,
      })),
      recommendedEquilibrium: recommended
        ? {
            profileId: recommended.profileId,
            stability: recommended.stability,
            description: recommended.description,
            strategies: recommendedStrategies,
          }
        : null,
      keyInsights: result.nash.keyInsights.slice(0, 6),
      breakEquilibriumMoves: result.nash.breakEquilibriumMoves.slice(0, 6),
      recommendations: result.nash.recommendations.slice(0, 6),
      articleExcerpt: truncatePromptText(result.nash.rawThinking, 1800),
    },
    complexityLayer: {
      resilienceScore: result.complexity.resilienceScore,
      adaptationCapacity: result.complexity.adaptationCapacity,
      lockInRisk: result.complexity.lockInRisk,
      cascadeRisk: result.complexity.cascadeRisk,
      optionalityScore: result.complexity.optionalityScore,
      agents: result.complexity.agentsUsed.map((agent) => ({
        name: agent.name,
        type: agent.type,
        weight: agent.weight,
        goals: agent.goals,
        likelyMoves: agent.likelyMoves,
      })),
      stateVariables: result.complexity.stateVariables,
      feedbackLoops: result.complexity.feedbackLoops,
      tippingPoints: result.complexity.tippingPoints,
      scenarios: result.complexity.scenarios.map((scenario) => ({
        label: scenario.label,
        description: scenario.description,
        outcomeSummary: scenario.outcomeSummary,
        finalState: scenario.finalState,
      })),
      dominantRegimes: result.complexity.dominantRegimes,
      earlySignals: result.complexity.earlySignals,
      regimeShiftTriggers: result.complexity.regimeShiftTriggers,
      keyInsights: result.complexity.keyInsights.slice(0, 6),
      recommendations: result.complexity.recommendations.slice(0, 6),
      articleExcerpt: truncatePromptText(result.complexity.rawThinking, 1800),
    },
    integratedLayer: {
      whereAnalysesAgree: result.whereAnalysesAgree,
      contradictions: result.contradictions,
      productImplications: result.productImplications,
      preDevelopmentChanges: result.preDevelopmentChanges,
      pilotDesign: result.pilotDesign,
      earlySignalsToWatch: result.earlySignalsToWatch,
    },
  };

  return `${buildCompactCaseBrief(data.type, data.title, data.description, data.context)}

## Данные совмещённого анализа
${JSON.stringify(compact, null, 2)}

Напиши объясняющую статью для генерального директора. Не предполагай, что читатель знает методологию или видел промежуточные экраны агента.`;
}

function buildFallbackAgentArticle(
  data: { title: string; description: string; context: string },
  players: Player[],
  assumptions: string[],
  aggregatedActors: string[],
  gameAnalysis: {
    equilibria: NashScenario[];
    recommendedEquilibrium: NashScenario | null;
    nashScore: number;
    riskLevel: AnalysisResult["riskLevel"];
    verdict: ProductDecision;
  },
  payoffAssessment: {
    confidence: number;
    gameType: string;
    keyInsights: string[];
    breakEquilibriumMoves: string[];
    recommendations: string[];
    sensitivityChecks: SensitivityCheck[];
  }
): string {
  const focal = players[0];
  const otherPlayers = players.slice(1).map((player) => player.name).join(", ");
  const sharedResource = payoffAssessment.keyInsights[0] || "общий ресурс игры — внимание, доверие, скорость запуска и способность участников координироваться";
  const target = gameAnalysis.recommendedEquilibrium;
  const targetProfile = target?.profileId || "рекомендованный профиль";
  const targetStrategies = target
    ? players.map((player) => `${player.name} выбирает «${target.strategies[player.id]}»`).join(", ")
    : "точное целевое равновесие не найдено, поэтому агент опирается на лучший приближённый профиль";
  const badMove = payoffAssessment.breakEquilibriumMoves[0]
    || "ключевой участник получает стимул к отклонению, и ценность фичи для остальных падает";
  const action = payoffAssessment.recommendations[0]
    || "менять правила игры через ограничения запуска, дефолты, операционные договорённости и ранние сигналы остановки";
  const sensitivity = payoffAssessment.sensitivityChecks[0]?.note
    || assumptions[0]
    || aggregatedActors[0]
    || "часть факторов остаётся за пределами основной модели и требует проверки на запуске";

  return `В этом кейсе равновесие Нэша показывает не то, чего продуктовой команде больше всего хочется, а то, какая конфигурация стимулов может удержаться после столкновения интересов. Фича «${data.title}» выглядит как ${payoffAssessment.gameType || "многосторонняя продуктовая игра"}: ${focal?.name || "фокальный игрок"} принимает решение о запуске, но итог зависит от того, как ответят ${otherPlayers || "остальные участники"}. Каждый из них действует рационально для себя, и именно поэтому хороший продуктовый замысел может внезапно прийти к слабому результату.

Представьте рынок, где несколько сторон делят один и тот же узкий ресурс. Если один участник начинает брать больше внимания, надёжности или операционного времени, остальные не обязательно договариваются о коллективно лучшем решении. Они выбирают то, что защищает их собственный выигрыш. В результате возникает знакомая ловушка: индивидуально разумные действия складываются в плохую систему. Для этого кейса таким ресурсом становится не одна конкретная кнопка в интерфейсе, а вся связка ограничений: ${sharedResource}.

Роль ${focal?.name || "фокального игрока"} здесь в том, чтобы не просто выпустить фичу, а спроектировать игру так, чтобы остальные участники не захотели разрушить её своим лучшим ответом. ${players.map((player) => `${player.name} хочет сохранить собственную полезность через стратегию вроде «${player.strategies[0]}»`).join(". ")}. Конфликт возникает там, где рациональный выбор одного игрока перекладывает риск на другого: партнёр может ограничивать ресурс, пользователи могут не принять новый сценарий, операционная сторона может стать узким местом, а команда продукта всё равно будет заинтересована в запуске.

Плохое равновесие возникает, когда каждый действует логично, но система теряет ценность. Типичный сценарий здесь такой: ${badMove}. Тогда фича формально существует, но её принятие, доверие или операционная устойчивость оказываются ниже ожидаемого уровня. Это не ошибка одного игрока; это следствие правил игры, в которых у участников нет достаточного стимула поддерживать общий результат.

Рекомендованный профиль — ${targetProfile} — выглядит сильнее, потому что в нём стимулы выровнены лучше остальных: ${targetStrategies}. Индекс Нэша ${gameAnalysis.nashScore} при достоверности ${payoffAssessment.confidence} означает, что агент видит достаточно устойчивую позицию, но не считает её магически защищённой. Смысл рекомендации не в том, что этот профиль «самый красивый», а в том, что игрокам в нём сложнее получить заметный выигрыш от одиночного отклонения.

Отсюда продуктовый вывод: команда должна менять не формулировку требований, а правила взаимодействия участников. Нужно ${action}. Иначе продукт будет просить игроков вести себя кооперативно в ситуации, где им выгоднее защищать собственный интерес. Важный остаточный риск: ${sensitivity}.

Стратегически эта фича проектирует не только пользовательский сценарий, а рынок стимулов вокруг него. Задача PM — вывести участников из плохого равновесия, где каждый рационален по отдельности, но общий результат слабый, в полезное равновесие, где рациональное действие каждого поддерживает ценность продукта.`;
}

function buildDecisionUserPrompt(
  data: { type: string; title: string; description: string; context: string },
  players: Player[],
  assumptions: string[],
  aggregatedActors: string[],
  gameAnalysis: {
    recommendedEquilibrium: NashScenario | null;
    nashScore: number;
    riskLevel: AnalysisResult["riskLevel"];
    verdict: ProductDecision;
  },
  payoffAssessment: {
    confidence: number;
    gameType: string;
    keyInsights: string[];
    breakEquilibriumMoves: string[];
    recommendations: string[];
    sensitivityChecks: SensitivityCheck[];
  }
): string {
  const playersText = players
    .map(
      (player) =>
        `- ${player.id}: ${player.name} [${player.type}], weight=${player.weight}, incentives=${player.incentives}, strategies=[${player.strategies.join(", ")}]`
    )
    .join("\n");

  const sensitivityText = payoffAssessment.sensitivityChecks.length
    ? payoffAssessment.sensitivityChecks
        .map((check) => `- ${check.omittedPlayerId}: impact=${check.impact}; ${check.note}`)
        .join("\n")
    : "Нет";

  return `${buildCaseBrief(data.type, data.title, data.description, data.context, players)}

## Итог Nash-модели
Game type: ${payoffAssessment.gameType || "Не указан"}
Verdict: ${gameAnalysis.verdict}
Risk: ${gameAnalysis.riskLevel}
Nash score: ${gameAnalysis.nashScore}
Confidence: ${payoffAssessment.confidence}
Target equilibrium: ${gameAnalysis.recommendedEquilibrium?.profileId || "null"}

## Core players
${playersText}

## Target equilibrium strategies
${formatStrategiesForPrompt(gameAnalysis.recommendedEquilibrium, players)}

## Односторонние отклонения от target equilibrium
${formatDeviationsForPrompt(gameAnalysis.recommendedEquilibrium, players)}

## Key insights
${payoffAssessment.keyInsights.length ? payoffAssessment.keyInsights.join("\n") : "Нет"}

## Existing recommendations
${payoffAssessment.recommendations.length ? payoffAssessment.recommendations.join("\n") : "Нет"}

## Break-equilibrium moves
${payoffAssessment.breakEquilibriumMoves.length ? payoffAssessment.breakEquilibriumMoves.join("\n") : "Нет"}

## Sensitivity checks
${sensitivityText}

## Aggregated actors
${aggregatedActors.length ? aggregatedActors.join("\n") : "Нет"}

## Assumptions
${assumptions.length ? assumptions.join("\n") : "Нет"}

Собери PM Decision Pack без PRD-правок.`;
}

interface LocalCaseSignals {
  referral: boolean;
  loyalty: boolean;
  fraud: boolean;
  marketplace: boolean;
  platformDependency: boolean;
  regulatory: boolean;
  timePressure: boolean;
  consumer: boolean;
}

function caseText(data: { title: string; description: string; context: string }): string {
  return `${data.title}\n${data.description}\n${data.context}`.toLowerCase();
}

function hasAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function buildLocalCaseSignals(data: { title: string; description: string; context: string }): LocalCaseSignals {
  const text = caseText(data);

  return {
    referral: hasAny(text, ["реферал", "referral", "invite", "приглаш", "пригласи"]),
    loyalty: hasAny(text, ["лояль", "балл", "bonus", "бонус", "cashback", "кэшбек"]),
    fraud: hasAny(text, ["фрод", "anti-fraud", "антифрод", "abuse", "ip", "device", "саморефера"]),
    marketplace: hasAny(text, ["маркетплейс", "marketplace", "seller", "merchant"]),
    platformDependency: hasAny(text, ["интеграц", "api", "admin", "админ", "бэклог", "panel", "crm", "лояльност"]),
    regulatory: hasAny(text, ["регуля", "compliance", "legal", "персональн", "privacy", "payment", "оплат"]),
    timePressure: hasAny(text, ["3кв", "4кв", "q3", "q4", "квартал", "срок", "deadline", "запуск"]),
    consumer: hasAny(text, ["покупател", "buyer", "клиент", "user", "друг", "пользоват"]),
  };
}

function mergePlayersForDebug(hintedPlayers: Player[], inferredPlayers: Player[]): Player[] {
  if (hintedPlayers.length >= 2) {
    const merged = [...hintedPlayers];
    const usedNames = new Set(merged.map((player) => player.name.trim().toLowerCase()));

    for (const player of inferredPlayers) {
      if (merged.length >= MAX_CORE_PLAYERS) {
        break;
      }

      const key = player.name.trim().toLowerCase();
      if (usedNames.has(key)) {
        continue;
      }

      merged.push(player);
      usedNames.add(key);
    }

    return merged;
  }

  return inferredPlayers;
}

function buildLocalDebugSetup(
  data: { type: string; title: string; description: string; context: string },
  hintedPlayers: Player[]
): { players: Player[]; aggregatedActors: string[]; assumptions: string[]; caseFrame: string; signals: LocalCaseSignals } {
  const signals = buildLocalCaseSignals(data);

  const inferredPlayers: Player[] = [
    {
      id: "seed_focal",
      name: "Наша продуктовая команда",
      type: "other",
      strategies: signals.referral
        ? ["Запустить широко с фиксированным бонусом", "Запустить поэтапно с жёстким антифродом"]
        : ["Запустить в полном объёме", "Запустить ограниченно и валидировать гипотезу"],
      incentives: signals.referral
        ? "Ускорить рост клиентской базы и LTV без взрывного роста CAC и фрода"
        : "Увеличить продуктовый эффект при приемлемом уровне риска и нагрузки",
      weight: 5,
      source: "inferred",
    },
    {
      id: "seed_competitor",
      name: signals.marketplace ? "Конкурирующий маркетплейс" : "Главный конкурент",
      type: "competitor",
      strategies: ["Скопировать механику и ответить быстро", "Не отвечать быстро"],
      incentives: "Снять эффект первого хода и не дать нам закрепить преимущество",
      weight: 4,
      source: "inferred",
    },
    {
      id: "seed_users",
      name: signals.consumer ? "Покупатели и текущая клиентская база" : "Целевые пользователи",
      type: "user",
      strategies: signals.referral
        ? ["Активно делиться и покупать", "Игнорировать механику"]
        : ["Принять решение и пользоваться", "Игнорировать запуск"],
      incentives: "Получить ценность без лишнего трения и потери доверия",
      weight: 5,
      source: "inferred",
    },
  ];

  if (signals.platformDependency || signals.loyalty || signals.timePressure) {
    inferredPlayers.push({
      id: "seed_ops",
      name: signals.loyalty ? "Система лояльности и внутренние операции" : "Внутренняя платформа и операции",
      type: "platform",
      strategies: ["Поддержать надёжную интеграцию", "Стать bottleneck и задержать запуск"],
      incentives: "Сохранить стабильность, не сломать расчёты и не получить операционный долг",
      weight: 4,
      source: "inferred",
    });
  }

  if (signals.fraud || signals.referral || signals.loyalty) {
    inferredPlayers.push({
      id: "seed_fraud",
      name: "Фродеры и abuse-сегмент",
      type: "other",
      strategies: ["Атаковать бонусную механику", "Не атаковать программу"],
      incentives: "Максимизировать выгоду от уязвимостей в механике начислений",
      weight: 3,
      source: "inferred",
    });
  } else if (signals.regulatory) {
    inferredPlayers.push({
      id: "seed_regulator",
      name: "Регулятор и compliance-функция",
      type: "regulator",
      strategies: ["Ужесточить требования", "Не вмешиваться активно"],
      incentives: "Минимизировать юридические и репутационные риски программы",
      weight: 4,
      source: "inferred",
    });
  }

  const prepared = prepareCorePlayers(mergePlayersForDebug(hintedPlayers, inferredPlayers));

  const aggregatedActors = uniqueStrings(
    [
      "Остальной рынок",
      signals.marketplace ? "Продавцы / фермеры на платформе" : "",
      signals.referral ? "Маркетинг и CRM-команда" : "",
      signals.timePressure ? "Приоритеты соседних команд и релизный календарь" : "",
      signals.regulatory ? "Платёжные и юридические ограничения" : "",
      "Служба поддержки",
    ].filter(Boolean)
  );

  const assumptions = uniqueStrings(
    [
      "DEBUG_LOCAL_LLM активен: результат собран локальным эвристическим движком для отладки продукта и UI.",
      signals.referral ? "Пользовательская ценность программы зависит не только от бонуса, но и от простоты сценария приглашения." : "",
      signals.loyalty ? "Начисление и отображение бонусов должно быть консистентным, иначе доверие к механике резко падает." : "",
      signals.fraud ? "Фрод будет заметным фактором и может быстро съесть юнит-экономику при слишком широком rollout." : "",
      signals.platformDependency ? "Внутренние интеграции и операционная готовность влияют на outcome не меньше, чем реакция конкурентов." : "",
      signals.timePressure ? "Сжатые сроки усиливают trade-off между скоростью запуска и качеством защитных механизмов." : "",
      ...prepared.notes,
    ].filter(Boolean)
  );

  const caseFrame = signals.referral
    ? "Growth-фича с tension между acquisition, anti-fraud, качеством интеграции и скоростью запуска."
    : signals.platformDependency
      ? "Продуктовый запуск, где outcome определяется не только рынком, но и внутренними bottleneck-командами."
      : "Multi-player product launch game с фокусом на лучших ответах конкурентов и поведении пользователей.";

  return {
    players: prepared.players,
    aggregatedActors,
    assumptions,
    caseFrame,
    signals,
  };
}

function strategyMatches(strategy: string | undefined, patterns: RegExp): boolean {
  return Boolean(strategy && patterns.test(strategy.toLowerCase()));
}

function summarizeProfile(profile: StrategyProfile, players: Player[]): string {
  return players
    .map((player) => `${player.name}: ${profile.selections[player.id]}`)
    .join("; ");
}

function buildLocalDebugAssessment(
  data: { type: string; title: string; description: string; context: string },
  players: Player[],
  assumptions: string[],
  caseFrame: string,
  aggregatedActors: string[],
  signals: LocalCaseSignals
): {
  profiles: StrategyProfile[];
  confidence: number;
  gameType: string;
  keyInsights: string[];
  breakEquilibriumMoves: string[];
  recommendations: string[];
  sensitivityChecks: SensitivityCheck[];
  rawThinking: string;
} {
  const profiles = buildStrategyProfiles(players).map((profile) => {
    const payoffs: Record<string, number> = {};
    const focalPlayer = players[0];
    const competitor = players.find((player) => player.type === "competitor");
    const users = players.find((player) => player.type === "user");
    const platform = players.find((player) => player.type === "platform");
    const regulator = players.find((player) => player.type === "regulator");
    const fraudster = players.find((player) => player.name.toLowerCase().includes("фрод"));

    const focalStrategy = profile.selections[focalPlayer?.id ?? ""];
    const competitorStrategy = competitor ? profile.selections[competitor.id] : "";
    const userStrategy = users ? profile.selections[users.id] : "";
    const platformStrategy = platform ? profile.selections[platform.id] : "";
    const regulatorStrategy = regulator ? profile.selections[regulator.id] : "";
    const fraudStrategy = fraudster ? profile.selections[fraudster.id] : "";

    const wideLaunch = strategyMatches(focalStrategy, /широко|полном|быстро/);
    const controlledLaunch = strategyMatches(focalStrategy, /поэтапно|ограниченно|антифрод|валид/);
    const competitorCopies = strategyMatches(competitorStrategy, /скопир|ответить/);
    const usersActive = strategyMatches(userStrategy, /активно|делиться|покупать|принять|пользоваться/);
    const opsSupport = strategyMatches(platformStrategy, /поддержать|надёжн|интеграц/);
    const opsDelay = strategyMatches(platformStrategy, /bottleneck|задерж/);
    const regulatorTight = strategyMatches(regulatorStrategy, /ужесточ|вмеш/);
    const fraudAttacks = strategyMatches(fraudStrategy, /атаковать|abuse|фрод/);

    for (const player of players) {
      let payoff = 0;

      if (player.id === focalPlayer?.id) {
        payoff += wideLaunch ? 4 : 2;
        payoff += controlledLaunch ? 2 : 0;
        payoff += usersActive ? 4 : -3;
        payoff += competitorCopies ? -2 : 2;
        payoff += opsSupport ? 2 : 0;
        payoff += opsDelay ? (wideLaunch ? -4 : -2) : 0;
        payoff += fraudAttacks ? (wideLaunch ? -5 : -2) : 1;
        payoff += regulatorTight ? (wideLaunch ? -3 : -1) : 0;
        payoff += signals.timePressure && wideLaunch && opsSupport ? 1 : 0;
        payoff += signals.timePressure && controlledLaunch ? -1 : 0;
      } else if (player.type === "competitor") {
        payoff += competitorCopies ? (wideLaunch ? 4 : 2) : (wideLaunch ? -1 : 1);
        payoff += usersActive && competitorCopies ? 1 : 0;
      } else if (player.type === "user") {
        payoff += usersActive ? 4 : 0;
        payoff += wideLaunch ? 2 : 1;
        payoff += controlledLaunch ? 1 : 0;
        payoff += opsSupport ? 1 : 0;
        payoff += opsDelay ? -3 : 0;
        payoff += fraudAttacks ? -2 : 1;
      } else if (player.type === "platform") {
        payoff += opsSupport ? (controlledLaunch ? 4 : 2) : 0;
        payoff += opsDelay ? (wideLaunch ? 2 : 1) : 0;
        payoff += fraudAttacks && opsSupport ? -2 : 0;
        payoff += signals.timePressure && opsSupport ? -1 : 0;
      } else if (player.type === "regulator") {
        payoff += regulatorTight && (signals.regulatory || signals.fraud) && wideLaunch ? 3 : 0;
        payoff += !regulatorTight && controlledLaunch ? 1 : 0;
      } else if (player.name.toLowerCase().includes("фрод")) {
        payoff += fraudAttacks ? (wideLaunch ? 6 : 1) : 0;
        payoff += fraudAttacks && controlledLaunch ? -4 : 0;
        payoff += opsSupport ? -1 : 0;
      } else {
        payoff += usersActive ? 2 : 0;
        payoff += wideLaunch ? 1 : 0;
        payoff += fraudAttacks ? -1 : 0;
      }

      payoffs[player.id] = clamp(Math.round(payoff), -10, 10);
    }

    return {
      ...profile,
      payoffs,
      feasible: true,
      summary: summarizeProfile(profile, players),
    };
  });

  const confidence = clamp(
    58 +
      (signals.referral ? 8 : 0) +
      (signals.platformDependency ? 5 : 0) +
      (signals.fraud ? 4 : 0) -
      (signals.regulatory ? 3 : 0),
    45,
    82
  );

  const competitor = players.find((player) => player.type === "competitor");
  const platform = players.find((player) => player.type === "platform");
  const regulator = players.find((player) => player.type === "regulator");
  const fraudster = players.find((player) => player.name.toLowerCase().includes("фрод"));

  const gameType = signals.referral && signals.fraud
    ? "Growth loop / anti-fraud coordination game"
    : signals.platformDependency
      ? "Platform-constrained launch game"
      : signals.regulatory
        ? "Launch vs compliance game"
        : "Multi-player product launch game";

  const keyInsights = uniqueStrings([
    signals.referral
      ? "Ключевая дилемма — не только рост через реферальный канал, но и контроль фрода и доверия к начислениям."
      : "Ключевая дилемма — баланс скорости запуска и устойчивости позиции после ответа других игроков.",
    signals.platformDependency
      ? "Внутренняя интеграция и операционная готовность ведут себя как полноценный стратегический игрок и могут разрушить сильный rollout."
      : "Даже при хорошем пользовательском отклике outcome сильно зависит от лучшего ответа конкурентов.",
    "Для Nash-позиции важно не просто запустить механику, а выбрать такой режим запуска, при котором односторонний контрход других игроков становится менее выгодным.",
  ]);

  const breakEquilibriumMoves = uniqueStrings([
    competitor ? `${competitor.name} может быстро скопировать механику и снять эффект первого хода.` : "",
    fraudster ? `${fraudster.name} могут поднять abuse-rate и резко ухудшить экономику программы.` : "",
    platform ? `${platform.name} могут стать bottleneck и сорвать пользовательский опыт в момент запуска.` : "",
    regulator ? `${regulator.name} могут пересмотреть требования и повысить стоимость соблюдения правил.` : "",
  ]);

  const recommendations = uniqueStrings([
    signals.referral
      ? "Начинать с контролируемого rollout и заранее заложить антифрод, лимиты и сценарии ручной модерации."
      : "Запускать через ограниченный rollout с заранее определёнными guardrails и условиями масштабирования.",
    signals.loyalty
      ? "До релиза подтвердить SLA по интеграции лояльности, срокам начисления и точному отображению статусов в личном кабинете."
      : "Зафиксировать операционные зависимости и договориться о владельцах узких мест до старта разработки.",
    "Отслеживать не только acquisition, но и признаки разрушения равновесия: контрход конкурента, рост трения, снижение конверсии и всплески abuse/fraud.",
  ]);

  const sensitivityChecks = uniqueStrings(
    [
      signals.marketplace ? "Продавцы и партнёры могут изменить unit economics через маржинальность и доступность ассортимента." : "",
      signals.timePressure ? "Соседние команды и релизный календарь могут изменить outcome даже без внешних контрходов." : "",
      "Служба поддержки может стать скрытым ограничителем при резком росте входящего потока пользователей.",
    ].filter(Boolean)
  ).map((note, index) => {
    const impact: SensitivityCheck["impact"] =
      note.includes("поддержки") || note.includes("релиз") ? "high" : "medium";

    return {
      omittedPlayerId: index === 0 ? "support_or_ops" : index === 1 ? "release_calendar" : "partner_side",
      impact,
      note,
    };
  });

  const rawThinking = [
    "DEBUG_LOCAL_LLM: локальный эвристический движок использован вместо внешнего LLM.",
    `Фрейм игры: ${caseFrame}`,
    `Выделено игроков: ${players.map((player) => `${player.name} [${player.type}]`).join(", ")}`,
    aggregatedActors.length > 0 ? `Агрегированные акторы: ${aggregatedActors.join(", ")}` : "",
    assumptions.length > 0 ? `Assumptions: ${assumptions.join(" | ")}` : "",
    signals.referral
      ? "Сценарий похож на growth-механику, где payoff фокального игрока максимален при хорошем пользовательском отклике, контролируемом фроде и отсутствии мгновенного copycat-ответа."
      : "Сценарий оценён как multi-player launch game с ключевой ролью пользовательского отклика, контрходов конкурентов и внутренних ограничений.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    profiles,
    confidence,
    gameType,
    keyInsights,
    breakEquilibriumMoves,
    recommendations,
    sensitivityChecks,
    rawThinking,
  };
}

function runLocalDebugAnalysis(
  data: { type: string; title: string; description: string; players: string; context: string }
): AnalysisResult {
  const hintedPlayers = parsePlayersInput(data.players);
  const setup = buildLocalDebugSetup(data, hintedPlayers);
  const assessment = buildLocalDebugAssessment(
    data,
    setup.players,
    setup.assumptions,
    setup.caseFrame,
    setup.aggregatedActors,
    setup.signals
  );
  const gameAnalysis = analyzeProfiles(setup.players, assessment.profiles, assessment.confidence);
  const agentArticle = buildFallbackAgentArticle(
    data,
    setup.players,
    setup.assumptions,
    setup.aggregatedActors,
    gameAnalysis,
    {
      confidence: assessment.confidence,
      gameType: assessment.gameType,
      keyInsights: assessment.keyInsights,
      breakEquilibriumMoves: assessment.breakEquilibriumMoves,
      recommendations: assessment.recommendations,
      sensitivityChecks: assessment.sensitivityChecks,
    },
  );
  const pairwiseViews = buildPairwiseViews(
    setup.players,
    assessment.profiles,
    gameAnalysis.equilibria,
    gameAnalysis.recommendedEquilibrium
  );
  const primaryPairwise = pairwiseViews[0];
  const decisionPack = buildFallbackDecisionPack({
    title: data.title,
    type: data.type,
    players: setup.players,
    confidence: assessment.confidence,
    nashScore: gameAnalysis.nashScore,
    verdict: gameAnalysis.verdict,
    recommendedEquilibrium: gameAnalysis.recommendedEquilibrium,
    keyInsights: assessment.keyInsights,
    breakEquilibriumMoves: assessment.breakEquilibriumMoves,
    recommendations: assessment.recommendations,
    sensitivityChecks: assessment.sensitivityChecks,
  });

  return {
    analysisMode: "nash",
    playersUsed: setup.players,
    aggregatedActors: setup.aggregatedActors,
    assumptions: uniqueStrings([
      ...setup.assumptions,
      setup.caseFrame ? `Фрейм игры: ${setup.caseFrame}` : "",
    ]),
    profiles: assessment.profiles,
    confidence: assessment.confidence,
    pairwiseViews,
    sensitivityChecks: assessment.sensitivityChecks,
    equilibria: gameAnalysis.equilibria,
    recommendedEquilibrium: gameAnalysis.recommendedEquilibrium,
    nashScore: gameAnalysis.nashScore,
    riskLevel: gameAnalysis.riskLevel,
    verdict: gameAnalysis.verdict,
    gameType: assessment.gameType,
    keyInsights: assessment.keyInsights,
    breakEquilibriumMoves: assessment.breakEquilibriumMoves,
    recommendations: assessment.recommendations,
    decisionPack,
    payoffMatrix: primaryPairwise?.matrix || [],
    matrixPlayers: primaryPairwise ? [...primaryPairwise.players] : [],
    matrixStrategies: primaryPairwise?.matrixStrategies || {},
    rawThinking: agentArticle,
  };
}

function buildLocalDebugComplexitySetupResponse(data: {
  type: string;
  title: string;
  description: string;
  context: string;
}): ComplexitySetupResponse {
  return {
    title: data.title,
    agentsUsed: [
      {
        id: "a1",
        name: "Команда продукта",
        type: "team",
        weight: 5,
        goals: ["Запустить механику без перегрузки системы", "Сохранить пространство для корректировок"],
        likelyMoves: ["Запустить ограниченный пилот", "Усилить наблюдение за ранними сигналами"],
        adaptationRules: [
          {
            id: "r1",
            label: "Сузить запуск при росте нагрузки",
            priority: 1,
            when: [{ variableId: "load", op: "gt", value: 62 }],
            move: "Сузить аудиторию пилота и усилить поддержку",
            impacts: { load: -8, trust: 3, optionality: 5 },
            rationale: "Команда снижает перегрузку и сохраняет возможность менять механику.",
          },
          {
            id: "r2",
            label: "Масштабировать при устойчивом принятии",
            priority: 2,
            when: [{ variableId: "adoption", op: "gt", value: 65 }],
            move: "Расширить охват при сохранении ограничителей",
            impacts: { adoption: 5, unit_economics: 3, load: 3 },
            rationale: "Хороший ранний сигнал позволяет расти, но создаёт операционное давление.",
          },
        ],
      },
      {
        id: "a2",
        name: "Целевые пользователи",
        type: "user",
        weight: 5,
        goals: ["Получить понятную ценность", "Избежать лишнего трения"],
        likelyMoves: ["Пробовать механику после понятного объяснения", "Отказываться при недоверии"],
        adaptationRules: [
          {
            id: "r1",
            label: "Усиливать использование при доверии",
            priority: 1,
            when: [{ variableId: "trust", op: "gt", value: 58 }],
            move: "Активнее пользоваться новой механикой",
            impacts: { adoption: 7, trust: 2, unit_economics: 4 },
            rationale: "Доверие снижает осторожность и ускоряет принятие.",
          },
          {
            id: "r2",
            label: "Уходить при росте трения",
            priority: 2,
            when: [{ variableId: "load", op: "gt", value: 65 }],
            move: "Откладывать использование механики",
            impacts: { adoption: -6, trust: -5 },
            rationale: "Пользователи быстро реагируют на сбои и непонятные условия.",
          },
        ],
      },
      {
        id: "a3",
        name: "Операционная команда",
        type: "platform",
        weight: 4,
        goals: ["Сохранить стабильность процессов", "Не допустить резкого роста ручной работы"],
        likelyMoves: ["Автоматизировать узкие места", "Ограничивать масштаб запуска"],
        adaptationRules: [
          {
            id: "r1",
            label: "Включать ручной контроль при рисках",
            priority: 1,
            when: [{ variableId: "fraud_pressure", op: "gt", value: 45 }],
            move: "Добавить ручную проверку спорных случаев",
            impacts: { fraud_pressure: -7, load: 5, trust: 2 },
            rationale: "Контроль снижает злоупотребления, но повышает нагрузку.",
          },
        ],
      },
    ],
    assumptions: [
      "DEBUG_LOCAL_LLM активен: структура системы собрана локально для проверки интерфейса и пайплайна.",
      "Модель описывает раннюю траекторию запуска, а не долгосрочную макроэкономическую динамику.",
    ],
    stateVariables: [
      { id: "adoption", name: "Принятие пользователями", description: "Доля целевого сегмента, которая начинает пользоваться механикой.", initialValue: 44, targetDirection: "up" },
      { id: "trust", name: "Доверие к механике", description: "Предсказуемость условий и уверенность участников.", initialValue: 54, targetDirection: "up" },
      { id: "load", name: "Операционная нагрузка", description: "Нагрузка на поддержку, операции и соседние команды.", initialValue: 36, targetDirection: "down" },
      { id: "fraud_pressure", name: "Давление злоупотреблений", description: "Риск атак на правила и экономику механики.", initialValue: 28, targetDirection: "down" },
      { id: "unit_economics", name: "Юнит-экономика", description: "Экономическая устойчивость ранней траектории.", initialValue: 50, targetDirection: "up" },
      { id: "optionality", name: "Пространство манёвров", description: "Насколько команда может менять условия без дорогого отката.", initialValue: 62, targetDirection: "up" },
    ],
    feedbackLoops: [
      {
        id: "loop_1",
        type: "reinforcing",
        label: "Доверие ускоряет принятие",
        description: "Чем понятнее и стабильнее механика, тем быстрее пользователи вовлекаются.",
        impacts: { adoption: 2, trust: 1 },
      },
      {
        id: "loop_2",
        type: "balancing",
        label: "Нагрузка сдерживает рост",
        description: "Рост принятия увеличивает нагрузку, а перегрузка снижает качество опыта.",
        impacts: { load: 2, trust: -1 },
      },
    ],
    tippingPoints: [
      { id: "tip_1", label: "Потеря доверия", variableId: "trust", threshold: 38, direction: "down", consequence: "Пользователи начинают избегать механики даже при формальной выгоде." },
      { id: "tip_2", label: "Операционная перегрузка", variableId: "load", threshold: 72, direction: "up", consequence: "Поддержка и операции становятся ограничителем роста." },
      { id: "tip_3", label: "Злоупотребления меняют экономику", variableId: "fraud_pressure", threshold: 68, direction: "up", consequence: "Механика теряет экономическую устойчивость." },
    ],
    pathDependencies: [
      { id: "path_1", earlyCondition: "Первый запуск проходит с понятными правилами и быстрым исправлением сбоев.", laterEffect: "Доверие закрепляется, и дальнейшие изменения воспринимаются спокойнее.", reversibility: "moderate" },
      { id: "path_2", earlyCondition: "Первые пользователи сталкиваются с задержками и непонятными условиями.", laterEffect: "Недоверие закрепляется и требует дорогой коммуникации для исправления.", reversibility: "hard" },
    ],
    interventions: [
      { id: "i1", timing: "prelaunch", label: "Пороговые ограничители пилота", description: "До запуска задать стоп-сигналы по нагрузке, доверию и злоупотреблениям.", intendedImpacts: { optionality: 8, load: -4 }, tradeoffs: ["Медленнее рост в первые недели"] },
      { id: "i2", timing: "launch", label: "Наблюдение за ранними сигналами", description: "Ежедневно отслеживать переменные, которые указывают на смену режима.", intendedImpacts: { trust: 4, fraud_pressure: -3 }, tradeoffs: ["Нужен отдельный владелец мониторинга"] },
    ],
    scenarios: [
      { id: "baseline", label: "Базовый сценарий", description: "Система развивается без сильного внешнего ускорения.", shocks: { adoption: 0, trust: 0, load: 1 } },
      { id: "upside", label: "Сценарий ускоренного роста", description: "Первые пользователи быстро подтверждают ценность механики.", shocks: { adoption: 4, trust: 3, unit_economics: 2 } },
      { id: "stress", label: "Стресс-сценарий", description: "Запуск сталкивается с перегрузкой и попытками злоупотреблений.", shocks: { adoption: -3, trust: -4, load: 5, fraud_pressure: 5, optionality: -3 } },
    ],
  };
}

function runLocalDebugComplexityAnalysis(
  data: { type: string; title: string; description: string; context: string },
  runtimeStats?: ComplexityAnalysisResult["runtimeStats"],
): ComplexityAnalysisResult {
  const setup = normalizeComplexitySetup(buildLocalDebugComplexitySetupResponse(data), data.title);
  const simulation = simulateComplexitySystem(setup);
  const decision = normalizeComplexityDecision({}, simulation);
  const rawThinking = [
    "Локальный режим собрал ограниченную адаптивную симуляцию без внешней языковой модели.",
    simulation.executiveSummary,
    "Главный смысл анализа: смотреть не на статически устойчивый профиль, а на то, как ранние реакции игроков меняют траекторию всей системы.",
    ...simulation.keyInsights,
  ].join("\n\n");

  return composeComplexityResult(data.title, setup, simulation, decision, rawThinking, runtimeStats);
}

function toIntegratedDecisionLabel(decision: IntegratedAnalysisResult["finalDecision"]): string {
  switch (decision) {
    case "launch":
      return "Запускать";
    case "pilot":
      return "Запустить пилот";
    case "revise":
      return "Поменять условия";
    case "pause":
      return "Взять паузу";
    case "kill":
      return "Не запускать";
    default:
      return "Поменять условия";
  }
}

function toProductDecision(decision: IntegratedAnalysisResult["finalDecision"]): ProductDecision {
  if (decision === "launch" || decision === "pause" || decision === "kill") {
    return decision;
  }

  return "revise";
}

function getAgreementLevel(scoreGap: number, nash: AnalysisResult, complexity: ComplexityAnalysisResult): IntegratedAnalysisResult["agreementLevel"] {
  const nashPositive = nash.verdict === "launch";
  const complexityPositive = complexity.verdict === "launch";
  const nashNegative = nash.verdict === "pause" || nash.verdict === "kill";
  const complexityNegative = complexity.verdict === "pause" || complexity.verdict === "kill";

  if (scoreGap <= 15 && ((nashPositive && complexityPositive) || (nashNegative && complexityNegative) || nash.verdict === complexity.verdict)) {
    return "high";
  }

  if (scoreGap <= 30 || nash.verdict === complexity.verdict) {
    return "medium";
  }

  return "low";
}

function getConvergenceExpectation(
  reachabilityOfNash: number,
  adaptationPressure: number,
  basinOfAttraction: IntegratedAnalysisResult["basinOfAttraction"],
  nash: AnalysisResult,
  complexity: ComplexityAnalysisResult,
): IntegratedAnalysisResult["convergenceExpectation"] {
  if (reachabilityOfNash >= 72 && nash.nashScore >= 68 && basinOfAttraction === "wide") {
    return "toward_recommended_equilibrium";
  }

  if (nash.nashScore < 45 && complexity.lockInRisk >= 65) {
    return "toward_bad_equilibrium";
  }

  if (basinOfAttraction === "fragmented") {
    return "fragmented";
  }

  if (adaptationPressure >= 70 && complexity.cascadeRisk >= 55) {
    return "cycling";
  }

  return "non_convergent";
}

function getConvergenceExpectationLabel(value: IntegratedAnalysisResult["convergenceExpectation"]): string {
  switch (value) {
    case "toward_recommended_equilibrium":
      return "система движется к рекомендованному равновесию";
    case "toward_bad_equilibrium":
      return "система рискует закрепиться в плохом равновесии";
    case "cycling":
      return "возможны повторяющиеся колебания поведения игроков";
    case "fragmented":
      return "траектория распадается на несколько локальных режимов";
    case "non_convergent":
      return "устойчивой траектории пока не видно";
    default:
      return "траектория неопределённа";
  }
}

function localizeIntegratedArticleText(value: unknown): string {
  return normalizePdfText(value)
    .replace(/\bNash score\b/gi, "индекс Нэша")
    .replace(/\bNash-равновес/gi, "равновес")
    .replace(/\bNash\b/g, "Нэша")
    .replace(/\bbest-effort\b/gi, "лучший приближённый")
    .replace(/\bbottleneck\b/gi, "узкое место")
    .replace(/\brollout\b/gi, "постепенный запуск")
    .replace(/\bguardrails\b/gi, "ограничители")
    .replace(/\bpayoff\b/gi, "выигрыш")
    .replace(/\bscore\b/gi, "индекс")
    .replace(/\bFeature\b/g, "Фича")
    .replace(/\bPM\b/g, "продакт-менеджер");
}

function formatListForArticle(items: string[], fallback = "нет отдельных пунктов"): string {
  const values = uniqueStrings(items.map(localizeIntegratedArticleText)).filter(Boolean);
  return values.length ? values.join("; ") : fallback;
}

function formatPlayersForIntegratedArticle(players: Player[]): string {
  if (!players.length) {
    return "ключевые игроки не были выделены";
  }

  return players
    .map((player) => {
      const strategies = player.strategies?.length ? player.strategies.join(" / ") : "стратегии не указаны";
      return `${localizeIntegratedArticleText(player.name)}: стимул — ${localizeIntegratedArticleText(player.incentives || "не указан")}; возможные ходы — ${localizeIntegratedArticleText(strategies)}`;
    })
    .join("; ");
}

function formatRecommendedEquilibriumForIntegratedArticle(result: AnalysisResult): string {
  const recommended = result.recommendedEquilibrium;
  const playersById = new Map((result.playersUsed || []).map((player) => [player.id, player]));

  if (!recommended) {
    return "точное рекомендованное равновесие не найдено; агент использует лучший из найденных профилей как ориентир для изменения правил игры";
  }

  const strategies = Object.entries(recommended.strategies || {})
    .map(([playerId, strategy]) => {
      const player = playersById.get(playerId);
      const payoff = recommended.payoffs?.[playerId];
      return `${localizeIntegratedArticleText(player?.name || playerId)}: ${localizeIntegratedArticleText(strategy)}${typeof payoff === "number" ? ` (выигрыш ${payoff})` : ""}`;
    })
    .join("; ");

  return `${localizeIntegratedArticleText(recommended.description || "рекомендованный профиль")} Стратегии: ${strategies || "не указаны"}.`;
}

function formatComplexityScenarioSummary(result: ComplexityAnalysisResult): string {
  if (!result.scenarios?.length) {
    return "сценарные траектории не построены";
  }

  return result.scenarios
    .map((scenario) => `${localizeIntegratedArticleText(scenario.label)}: ${localizeIntegratedArticleText(scenario.outcomeSummary || scenario.description)}`)
    .join("; ");
}

function buildFallbackIntegratedArticle(
  data: { title: string; description: string; context: string },
  result: Omit<IntegratedAnalysisResult, "rawThinking">,
): string {
  const agreementText =
    result.agreementLevel === "high"
      ? "высокая"
      : result.agreementLevel === "medium"
        ? "средняя"
        : "низкая";
  const basinText =
    result.basinOfAttraction === "wide"
      ? "широкая"
      : result.basinOfAttraction === "narrow"
        ? "узкая"
        : "фрагментированная";
  const caseContext = localizeIntegratedArticleText(truncatePromptText(data.description, 900));
  const players = formatPlayersForIntegratedArticle(result.nash.playersUsed || []);
  const recommendedEquilibrium = formatRecommendedEquilibriumForIntegratedArticle(result.nash);
  const scenarios = formatComplexityScenarioSummary(result.complexity);

  return [
    "Краткий вывод для руководителя",
    `Мы анализировали кейс «${localizeIntegratedArticleText(data.title || result.title)}» не как список продуктовых пожеланий, а как систему поведения нескольких участников. В такой системе успех зависит не только от того, хочет ли компания запустить фичу или стратегию, но и от того, как на неё рационально отреагируют пользователи, партнёры, конкуренты, операционные команды и внешние платформы. Итоговый вывод: ${localizeIntegratedArticleText(result.decisionLabel.toLowerCase())}. Главная причина — ${localizeIntegratedArticleText(result.finalRecommendation)}`,
    `Суть кейса: ${caseContext || "описание кейса не было заполнено подробно"}. Для руководителя важно, что агент проверял не красоту идеи, а устойчивость будущей бизнес-конфигурации: кто получает выгоду, кто несёт издержки, где возникнет сопротивление и сможет ли система сама прийти к полезному состоянию после первых реакций рынка.`,
    "Как читать совмещённый анализ",
    "Первый слой — равновесие Нэша. Простыми словами, это проверка устойчивости стимулов: существует ли такая конфигурация действий, при которой каждому ключевому игроку рационально оставаться в выбранной стратегии, потому что односторонний уход делает его положение не лучше, а хуже. Этот слой похож на фотографию игры в один момент времени: мы фиксируем игроков, стратегии и выигрыши и спрашиваем, насколько устойчиво выбранное положение.",
    "Второй слой — экономика сложности. Он отвечает на другой вопрос: даже если на фотографии есть привлекательное равновесие, сможет ли реальная система до него дойти. Здесь игроки не стоят на месте: они учатся, копируют удачные ходы, реагируют на сбои, меняют цены, снижают или повышают участие, усиливают или ослабляют доверие. Поэтому этот слой похож не на фотографию, а на фильм о том, как ранние события меняют дальнейшую траекторию.",
    "Кто участвует в игре",
    `В модели Нэша ключевые игроки выглядят так: ${players}. Это не просто заинтересованные стороны. Каждый из них имеет собственную рациональность: пользователь выбирает удобство и доверие, партнёр или продавец выбирает окупаемость усилий, платформа выбирает рост при контролируемой нагрузке, конкурент выбирает скорость ответа, а операционная команда выбирает устойчивость процессов. Если продуктовый дизайн не учитывает эти стимулы, участники будут действовать логично для себя, но итог для компании может оказаться слабым.`,
    "Что показал слой равновесия Нэша",
    `Статическая устойчивость получила ${result.staticStabilityScore} из 100. Рекомендованный профиль можно описать так: ${recommendedEquilibrium} Это означает, что в зафиксированной игре есть понятная целевая конфигурация поведения. Но важна не сама цифра, а её смысл: чем выше статическая устойчивость, тем меньше у игроков причин немедленно отклоняться от целевого сценария, если правила игры уже настроены правильно.`,
    `При этом слой Нэша показывает и угрозы нарушения равновесия: ${formatListForArticle(result.nash.breakEquilibriumMoves)}. Эти угрозы важны для управления, потому что они указывают, где игроки могут рационально уйти из желаемого сценария. Например, пользователь может не принять фичу, партнёр может не поддержать нужный уровень качества, внешняя платформа может стать узким местом, а команда может столкнуться с издержками, которые не были видны в первоначальном плане.`,
    "Что показала экономика сложности",
    `Динамическая устойчивость получила ${result.dynamicStabilityScore} из 100. Здесь агент смотрел уже не на один профиль действий, а на траектории системы. Сценарии выглядят так: ${scenarios}. Ключевые переменные состояния: ${formatListForArticle(result.complexity.stateVariables.map((variable) => `${variable.name} — стартовое значение ${variable.initialValue}`))}. Эти переменные важны потому, что они меняют поведение игроков: доверие ускоряет принятие, нагрузка может сдержать рост, злоупотребления могут разрушить экономику, а пространство манёвра определяет, насколько дорого будет откатывать ошибочный запуск.`,
    `Особое внимание нужно уделить пороговым переломам и ранним сигналам. В модели выделены сигналы: ${formatListForArticle(result.earlySignalsToWatch)}. Их смысл не в том, чтобы «посмотреть аналитику после запуска», а в том, чтобы заранее договориться, какие управленческие действия будут включены при их появлении: сузить аудиторию, изменить правила, отключить часть сценария, усилить поддержку, поменять коммуникацию или остановить масштабирование.`,
    "Где два подхода сходятся и расходятся",
    `Согласованность двух подходов: ${agreementText}. Достижимость равновесия — ${result.reachabilityOfNash} из 100. Это центральная метрика совмещённого анализа. Она не означает общую вероятность коммерческого успеха. Она показывает более конкретную вещь: насколько реальные реакции игроков способны привести систему к тому устойчивому профилю, который выглядит разумным в статической модели.`,
    result.contradictions.length
      ? `Главные противоречия между слоями: ${formatListForArticle(result.contradictions)}. Если равновесие выглядит сильным на бумаге, но динамическая устойчивость низкая, это означает: план может быть правильным, но система до него не дойдёт без дополнительных условий. Если динамика выглядит лучше статической игры, это означает: потенциал есть, но текущие стимулы игроков ещё не выровнены.`
      : `В этом кейсе явного конфликта между слоями немного. Это хороший знак, но не повод отключать осторожность: даже при согласованных выводах область притяжения может быть ${basinText}, а значит путь к устойчивому состоянию всё ещё зависит от первых решений и ограничителей запуска.`,
    "Плохая траектория",
    `Плохая траектория возникает не потому, что кто-то ведёт себя «неправильно». Она возникает, когда каждый участник действует рационально в рамках своих стимулов, но общая система деградирует. Пользователь избегает фичи при недостатке доверия, партнёр снижает участие при низкой выгоде или высокой сложности, операционная команда ограничивает масштаб при росте нагрузки, внешний поставщик становится источником сбоев, а конкурент копирует механику и снижает эффект первого хода. В результате компания может получить не рост, а слабое принятие, рост ручной работы, потерю доверия или дорогую зависимость от раннего ошибочного решения.`,
    "Желаемая траектория",
    `Желаемая траектория требует не убеждать игроков «вести себя лучше», а изменить правила игры так, чтобы полезное поведение стало рациональным. Для этого агент предлагает до разработки или перед запуском: ${formatListForArticle(result.preDevelopmentChanges)}. Если выбран пилот, его смысл не в осторожности ради осторожности. Пилот должен проверить, двигается ли система к целевому профилю: растёт ли доверие, сохраняется ли качество, не перегружаются ли операции, не возникает ли каскадный сбой и остаётся ли у компании возможность изменить условия без дорогого отката.`,
    "Управленческое решение",
    `Решение «${localizeIntegratedArticleText(result.decisionLabel)}» означает следующее: ${localizeIntegratedArticleText(result.finalRecommendation)} Область притяжения оценена как ${basinText}. Если она широкая, продукт может выдержать больше случайных отклонений. Если узкая, нужен аккуратный запуск с ограничителями. Если фрагментированная, разные группы игроков могут уйти в разные режимы поведения, и единый массовый запуск становится рискованным.`,
    "Стратегический вывод",
    `Компания проектирует не только фичу, экран или процесс. Она проектирует систему стимулов. Совмещённый анализ показывает, что сильная стратегия должна одновременно иметь устойчивое равновесие и достижимую траекторию к нему. Если есть только первое, получается красивый план, который рынок может не воспроизвести. Если есть только второе, система движется, но не обязательно к выгодному состоянию. Поэтому главный вопрос перед разработкой звучит так: какие условия нужно встроить в продукт, чтобы рациональные действия пользователей, партнёров, команд и внешних игроков сами вели систему к нужному для бизнеса результату.`,
  ].join("\n\n");
}

function composeIntegratedAnalysisResult(
  data: { title: string; description: string; context: string },
  nash: AnalysisResult,
  complexity: ComplexityAnalysisResult,
  runtimeStats?: IntegratedAnalysisResult["runtimeStats"],
): IntegratedAnalysisResult {
  const staticStabilityScore = clamp(Math.round(nash.nashScore), 0, 100);
  const dynamicStabilityScore = clamp(
    Math.round(
      complexity.resilienceScore * 0.4 +
        complexity.adaptationCapacity * 0.25 +
        complexity.optionalityScore * 0.2 +
        (100 - complexity.cascadeRisk) * 0.15
    ),
    0,
    100,
  );
  const reachabilityOfNash = clamp(
    Math.round(
      staticStabilityScore * 0.42 +
        complexity.resilienceScore * 0.24 +
        complexity.optionalityScore * 0.18 +
        complexity.adaptationCapacity * 0.12 -
        complexity.lockInRisk * 0.18 -
        complexity.cascadeRisk * 0.14
    ),
    0,
    100,
  );
  const scoreGap = Math.abs(staticStabilityScore - dynamicStabilityScore);
  const adaptationPressure = clamp(
    Math.round(
      100 -
        complexity.adaptationCapacity * 0.5 +
        complexity.cascadeRisk * 0.3 +
        complexity.lockInRisk * 0.25 +
        scoreGap * 0.25
    ),
    0,
    100,
  );
  const basinOfAttraction: IntegratedAnalysisResult["basinOfAttraction"] =
    reachabilityOfNash >= 72 && complexity.cascadeRisk < 50 && complexity.lockInRisk < 60
      ? "wide"
      : reachabilityOfNash < 45 || complexity.cascadeRisk >= 72 || scoreGap >= 35
        ? "fragmented"
        : "narrow";
  const convergenceExpectation = getConvergenceExpectation(
    reachabilityOfNash,
    adaptationPressure,
    basinOfAttraction,
    nash,
    complexity,
  );
  const agreementLevel = getAgreementLevel(scoreGap, nash, complexity);

  let finalDecision: IntegratedAnalysisResult["finalDecision"];
  if (staticStabilityScore >= 72 && dynamicStabilityScore >= 68 && reachabilityOfNash >= 68) {
    finalDecision = "launch";
  } else if (staticStabilityScore >= 65 && dynamicStabilityScore < 60) {
    finalDecision = "pilot";
  } else if (staticStabilityScore < 55 && dynamicStabilityScore >= 60) {
    finalDecision = "revise";
  } else if (staticStabilityScore < 45 && dynamicStabilityScore < 45) {
    finalDecision = complexity.lockInRisk >= 75 || complexity.cascadeRisk >= 75 ? "kill" : "pause";
  } else {
    finalDecision = reachabilityOfNash >= 55 ? "pilot" : "revise";
  }

  const decisionLabel = toIntegratedDecisionLabel(finalDecision);
  const agreementText = agreementLevel === "high" ? "высокое" : agreementLevel === "medium" ? "среднее" : "низкое";
  const whereAnalysesAgree = uniqueStrings([
    staticStabilityScore >= 65 && dynamicStabilityScore >= 60
      ? "Статическая игра и адаптивная траектория одновременно поддерживают осторожный запуск."
      : "",
    staticStabilityScore < 55 && dynamicStabilityScore < 55
      ? "Оба слоя показывают, что текущие условия запуска недостаточно устойчивы."
      : "",
    complexity.cascadeRisk >= 60 || nash.riskLevel === "high" || nash.riskLevel === "critical"
      ? "Главный риск связан не с одной ошибкой, а с распространением реакции игроков по системе."
      : "",
    nash.confidence >= 65 && complexity.confidence >= 65
      ? "Качество исходной игровой модели достаточно для продуктового решения перед разработкой."
      : "",
  ]);
  const contradictions = uniqueStrings([
    staticStabilityScore >= 70 && dynamicStabilityScore < 60
      ? "Равновесие выглядит привлекательным на статической матрице, но адаптивная динамика показывает трудную достижимость."
      : "",
    staticStabilityScore < 55 && dynamicStabilityScore >= 65
      ? "Статическая игра не даёт сильного равновесия, но система может улучшиться через ранние вмешательства и обучение игроков."
      : "",
    scoreGap >= 30
      ? `Разрыв между статической устойчивостью и динамической устойчивостью составляет ${scoreGap} пунктов.`
      : "",
    complexity.lockInRisk >= 65
      ? "Есть риск рано закрепить траекторию, которую потом будет дорого развернуть даже при формально рациональных стратегиях."
      : "",
  ]);
  const productImplications = uniqueStrings([
    `Достижимость равновесия: ${reachabilityOfNash}/100. Это оценка того, насколько реальные адаптации игроков способны привести к рекомендованному профилю.`,
    `Ожидаемая траектория: ${getConvergenceExpectationLabel(convergenceExpectation)}.`,
    `Область притяжения: ${basinOfAttraction === "wide" ? "широкая" : basinOfAttraction === "narrow" ? "узкая" : "фрагментированная"}.`,
    ...nash.keyInsights.slice(0, 2),
    ...complexity.keyInsights.slice(0, 2),
  ]);
  const preDevelopmentChanges = uniqueStrings([
    ...(finalDecision === "launch" ? nash.decisionPack?.launchGuardrails || [] : []),
    ...(finalDecision === "pilot" || finalDecision === "revise" ? complexity.interventions.map((item) => item.label) : []),
    ...nash.recommendations.slice(0, 2),
    ...complexity.recommendations.slice(0, 2),
  ]).slice(0, 7);
  const pilotDesign = uniqueStrings([
    "Запускать через ограниченную аудиторию и заранее заданные стоп-сигналы.",
    "Отслеживать не только целевую метрику, но и переменные состояния системы: доверие, нагрузку, злоупотребления, пространство для манёвра.",
    "Сравнивать фактические реакции игроков с рекомендованным профилем равновесия.",
    ...complexity.earlySignals.slice(0, 3),
  ]);
  const earlySignalsToWatch = uniqueStrings([
    ...complexity.earlySignals,
    ...complexity.regimeShiftTriggers,
    ...nash.breakEquilibriumMoves.slice(0, 3),
  ]).slice(0, 10);
  const confidence = clamp(Math.round((nash.confidence + complexity.confidence + (100 - scoreGap)) / 3), 0, 100);
  const finalRecommendation =
    finalDecision === "launch"
      ? "Можно передавать в разработку, но сохранить ограничители запуска и мониторинг ранних сигналов."
      : finalDecision === "pilot"
        ? "Не запускать сразу на всю аудиторию: сначала проверить достижимость равновесия на управляемом пилоте."
        : finalDecision === "revise"
          ? "Перед разработкой изменить стимулы, правила или границы аудитории, чтобы статическая устойчивость и динамическая траектория сошлись."
          : finalDecision === "pause"
            ? "Взять паузу и собрать недостающие данные: сейчас риск неверной траектории выше пользы от немедленного запуска."
            : "Не запускать в текущем виде: риск закрепить плохую траекторию слишком высок.";

  const resultWithoutRawThinking: Omit<IntegratedAnalysisResult, "rawThinking"> = {
    analysisMode: "integrated",
    modelKind: "arthur_sandholm_hybrid",
    title: data.title || nash.decisionPack?.targetEquilibrium || complexity.title,
    executiveSummary: `${decisionLabel}. ${finalRecommendation} Согласованность подходов: ${agreementText}; достижимость равновесия: ${reachabilityOfNash}/100.`,
    nash,
    complexity,
    staticStabilityScore,
    dynamicStabilityScore,
    reachabilityOfNash,
    adaptationPressure,
    basinOfAttraction,
    pathDependenceRisk: complexity.lockInRisk,
    lockInRisk: complexity.lockInRisk,
    regimeShiftRisk: complexity.cascadeRisk,
    convergenceExpectation,
    agreementLevel,
    confidence,
    verdict: toProductDecision(finalDecision),
    finalDecision,
    decisionLabel,
    whereAnalysesAgree,
    contradictions,
    productImplications,
    preDevelopmentChanges,
    pilotDesign,
    earlySignalsToWatch,
    finalRecommendation,
    runtimeStats,
  };

  return {
    ...resultWithoutRawThinking,
    rawThinking: buildFallbackIntegratedArticle(data, resultWithoutRawThinking),
  };
}

function runLocalDebugIntegratedAnalysis(
  data: { type: string; title: string; description: string; players: string; context: string },
  runtimeStats?: IntegratedAnalysisResult["runtimeStats"],
): IntegratedAnalysisResult {
  const nash = {
    ...runLocalDebugAnalysis(data),
    runtimeStats,
  };
  const complexity = runLocalDebugComplexityAnalysis(data, runtimeStats);

  return composeIntegratedAnalysisResult(data, nash, complexity, runtimeStats);
}

async function inferComplexitySetup(
  client: OpenAI,
  analysisId: number,
  model: string,
  data: { type: string; title: string; description: string; context: string },
  signal?: AbortSignal
): Promise<NormalizedComplexitySetup> {
  const raw = await requestJson<ComplexitySetupResponse>(
    client,
    analysisId,
    model,
    "setup",
    "Сборка адаптивной модели системы",
    COMPLEXITY_SETUP_SYSTEM_PROMPT,
    buildComplexitySetupUserPrompt(data),
    signal,
  );

  assertComplexityGuardrails(raw);
  const setup = normalizeComplexitySetup(raw, data.title);
  assertComplexityGuardrails(setup);
  return setup;
}

async function generateComplexityArticle(
  client: OpenAI,
  analysisId: number,
  model: string,
  data: { type: string; title: string; description: string; context: string },
  setup: NormalizedComplexitySetup,
  simulation: ReturnType<typeof simulateComplexitySystem>,
  signal?: AbortSignal
): Promise<string> {
  const raw = await requestJson<ComplexityArticleResponse>(
    client,
    analysisId,
    model,
    "finalizing",
    "Развёрнутый анализ траектории системы",
    COMPLEXITY_ARTICLE_SYSTEM_PROMPT,
    buildComplexityArticleUserPrompt(data, setup, simulation),
    signal,
  );

  const text = raw.rawThinking?.trim();
  if (!text) {
    throw new Error("LLM не вернула развёрнутый анализ Complexity-режима");
  }

  assertComplexityGuardrails(raw);
  return text;
}

async function generateComplexityDecisionPack(
  client: OpenAI,
  analysisId: number,
  model: string,
  data: { type: string; title: string; description: string; context: string },
  setup: NormalizedComplexitySetup,
  simulation: ReturnType<typeof simulateComplexitySystem>,
  signal?: AbortSignal
): Promise<ReturnType<typeof normalizeComplexityDecision>> {
  const raw = await requestJson<ComplexityDecisionResponse>(
    client,
    analysisId,
    model,
    "finalizing",
    "Пакет решения по адаптивной траектории",
    COMPLEXITY_DECISION_SYSTEM_PROMPT,
    buildComplexityDecisionUserPrompt(data, setup, simulation),
    signal,
  );

  assertComplexityGuardrails(raw);
  return normalizeComplexityDecision(raw, simulation);
}

async function inferStrategicSetup(
  client: OpenAI,
  analysisId: number,
  model: string,
  data: { type: string; title: string; description: string; context: string },
  hintedPlayers: Player[],
  signal?: AbortSignal
): Promise<{ players: Player[]; aggregatedActors: string[]; assumptions: string[]; caseFrame: string }> {
  const raw = await requestJson<StrategicSetupResponse>(
    client,
    analysisId,
    model,
    "setup",
    "Выделение игроков и границ игры",
    SETUP_SYSTEM_PROMPT,
    buildSetupUserPrompt(data.type, data.title, data.description, data.context, hintedPlayers),
    signal
  );

  const inferredPlayers = Array.isArray(raw.players)
    ? raw.players
        .map((player, index) => normalizePlayer(player, index, hintedPlayers.length > 0 ? "merged" : "inferred"))
        .filter((player): player is Player => Boolean(player))
    : [];

  if (inferredPlayers.length < 2 && hintedPlayers.length < 2) {
    throw new Error("LLM did not return enough valid players for analysis");
  }

  const prepared = prepareCorePlayers(inferredPlayers.length >= 2 ? inferredPlayers : hintedPlayers);

  return {
    players: prepared.players,
    aggregatedActors: normalizeTextList(raw.aggregatedActors),
    assumptions: uniqueStrings([
      ...normalizeTextList(raw.assumptions),
      ...prepared.notes,
    ]),
    caseFrame: raw.caseFrame?.trim() || "",
  };
}

async function assessProfiles(
  client: OpenAI,
  analysisId: number,
  model: string,
  data: { type: string; title: string; description: string; context: string },
  players: Player[],
  assumptions: string[],
  caseFrame: string,
  aggregatedActors: string[],
  profiles: StrategyProfile[],
  signal?: AbortSignal
): Promise<{
  profiles: StrategyProfile[];
  confidence: number;
  gameType: string;
  keyInsights: string[];
  breakEquilibriumMoves: string[];
  recommendations: string[];
  sensitivityChecks: SensitivityCheck[];
  rawThinking: string;
}> {
  const batchSize = getProfileBatchSize();
  const batches = chunkArray(profiles, batchSize);
  const scoredProfiles: StrategyProfile[] = [];

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    throwIfAborted(signal);
    const batch = batches[batchIndex];
    const firstProfileNumber = scoredProfiles.length + 1;
    const lastProfileNumber = scoredProfiles.length + batch.length;

    updateLiveProgress(analysisId, {
      phase: "payoff",
      phaseLabel: `Оценка профилей ${firstProfileNumber}-${lastProfileNumber} из ${profiles.length}`,
      llmStatus: `Пачка ${batchIndex + 1} из ${batches.length} готовится к LLM`,
      profileCount: profiles.length,
      profileProcessedCount: scoredProfiles.length,
    });

    const rawBatch = await requestJson<PayoffBatchResponse>(
      client,
      analysisId,
      model,
      "payoff",
      `Оценка профилей ${firstProfileNumber}-${lastProfileNumber} из ${profiles.length}`,
      PAYOFF_BATCH_SYSTEM_PROMPT,
      buildProfilesBatchUserPrompt(
        data,
        players,
        assumptions,
        caseFrame,
        batch,
        aggregatedActors,
        batchIndex,
        batches.length
      ),
      signal,
      {
        profileCount: profiles.length,
        profileProcessedCount: scoredProfiles.length,
        profileIds: batch.map((profile) => profile.id),
      }
    );

    scoredProfiles.push(...hydrateProfiles(batch, rawBatch.profiles, players));
    updateLiveProgress(analysisId, {
      phase: "payoff",
      phaseLabel: "Оценка стратегических профилей",
      llmStatus: `Оценено ${scoredProfiles.length} из ${profiles.length} профилей`,
      profileCount: profiles.length,
      profileProcessedCount: scoredProfiles.length,
    });
  }

  updateLiveProgress(analysisId, {
    phase: "payoff",
    phaseLabel: "Синтез payoff-модели",
    llmStatus: `Все профили оценены: ${scoredProfiles.length} из ${profiles.length}. Сжимаем матрицу выигрышей в общую картину.`,
    profileCount: profiles.length,
    profileProcessedCount: scoredProfiles.length,
  });

  const raw = await requestJson<PayoffSynthesisResponse>(
    client,
    analysisId,
    model,
    "payoff",
    "Синтез payoff-модели",
    PAYOFF_SYNTHESIS_SYSTEM_PROMPT,
    buildPayoffSynthesisUserPrompt(
      data,
      players,
      assumptions,
      caseFrame,
      aggregatedActors,
      scoredProfiles
    ),
    signal,
    {
      profileCount: profiles.length,
      profileProcessedCount: scoredProfiles.length,
      maxAttempts: 3,
    }
  );

  if (typeof raw.confidence !== "number") {
    throw new Error("LLM did not return confidence");
  }

  return {
    profiles: scoredProfiles,
    confidence: clamp(Math.round(raw.confidence), 20, 95),
    gameType: raw.gameType?.trim() || "",
    keyInsights: normalizeTextList(raw.keyInsights),
    breakEquilibriumMoves: normalizeTextList(raw.breakEquilibriumMoves),
    recommendations: normalizeTextList(raw.recommendations),
    sensitivityChecks: normalizeSensitivityChecks(raw.sensitivityChecks),
    rawThinking: "",
  };
}

async function generateAgentArticle(
  client: OpenAI,
  analysisId: number,
  model: string,
  data: { type: string; title: string; description: string; context: string },
  players: Player[],
  assumptions: string[],
  aggregatedActors: string[],
  gameAnalysis: {
    equilibria: NashScenario[];
    recommendedEquilibrium: NashScenario | null;
    nashScore: number;
    riskLevel: AnalysisResult["riskLevel"];
    verdict: ProductDecision;
  },
  payoffAssessment: {
    profiles: StrategyProfile[];
    confidence: number;
    gameType: string;
    keyInsights: string[];
    breakEquilibriumMoves: string[];
    recommendations: string[];
    sensitivityChecks: SensitivityCheck[];
  },
  signal?: AbortSignal
): Promise<string> {
  const fallback = buildFallbackAgentArticle(
    data,
    players,
    assumptions,
    aggregatedActors,
    gameAnalysis,
    payoffAssessment,
  );

  try {
    return await requestText(
      client,
      analysisId,
      model,
      "finalizing",
      "Развёрнутый анализ агента",
      AGENT_ARTICLE_SYSTEM_PROMPT,
      buildAgentArticleUserPrompt(
        data,
        players,
        assumptions,
        aggregatedActors,
        gameAnalysis,
        payoffAssessment
      ),
      signal
    );
  } catch (error) {
    if (signal?.aborted || isAbortLikeError(error)) {
      throw new AnalysisCancelledError();
    }

    const errorMessage = getErrorMessage(error);
    appendLivePreview(
      analysisId,
      `\n\n[Развёрнутый анализ агента] Не удалось получить статью от LLM, собрали fallback из Nash-модели: ${errorMessage}\n`,
      {
        phase: "finalizing",
        phaseLabel: "Развёрнутый анализ агента",
        llmStatus: "Статья собрана из уже рассчитанной Nash-модели",
        error: null,
      },
      false,
    );
    return fallback;
  }
}

async function generateIntegratedArticle(
  client: OpenAI,
  analysisId: number,
  model: string,
  data: { type: string; title: string; description: string; context: string },
  result: IntegratedAnalysisResult,
  signal?: AbortSignal,
): Promise<string> {
  const fallback = result.rawThinking;

  try {
    return await requestText(
      client,
      analysisId,
      model,
      "finalizing",
      "Развёрнутый совмещённый вывод",
      INTEGRATED_ARTICLE_SYSTEM_PROMPT,
      buildIntegratedArticleUserPrompt(data, result),
      signal,
    );
  } catch (error) {
    if (signal?.aborted || isAbortLikeError(error)) {
      throw new AnalysisCancelledError();
    }

    const errorMessage = getErrorMessage(error);
    appendLivePreview(
      analysisId,
      `\n\n[Развёрнутый совмещённый вывод] Не удалось получить статью от LLM, собрали объясняющий fallback из двух слоёв анализа: ${errorMessage}\n`,
      {
        phase: "finalizing",
        phaseLabel: "Развёрнутый совмещённый вывод",
        llmStatus: "Совмещённая статья собрана из уже рассчитанных слоёв анализа",
        error: null,
      },
      false,
    );
    return fallback;
  }
}

async function generateDecisionPack(
  client: OpenAI,
  analysisId: number,
  model: string,
  data: { type: string; title: string; description: string; context: string },
  players: Player[],
  assumptions: string[],
  aggregatedActors: string[],
  gameAnalysis: {
    recommendedEquilibrium: NashScenario | null;
    nashScore: number;
    riskLevel: AnalysisResult["riskLevel"];
    verdict: ProductDecision;
  },
  payoffAssessment: {
    confidence: number;
    gameType: string;
    keyInsights: string[];
    breakEquilibriumMoves: string[];
    recommendations: string[];
    sensitivityChecks: SensitivityCheck[];
  },
  signal?: AbortSignal
): Promise<DecisionPack> {
  const fallback = buildFallbackDecisionPack({
    title: data.title,
    type: data.type,
    players,
    confidence: payoffAssessment.confidence,
    nashScore: gameAnalysis.nashScore,
    verdict: gameAnalysis.verdict,
    recommendedEquilibrium: gameAnalysis.recommendedEquilibrium,
    keyInsights: payoffAssessment.keyInsights,
    breakEquilibriumMoves: payoffAssessment.breakEquilibriumMoves,
    recommendations: payoffAssessment.recommendations,
    sensitivityChecks: payoffAssessment.sensitivityChecks,
  });

  try {
    const raw = await requestJson<DecisionPackResponse>(
      client,
      analysisId,
      model,
      "finalizing",
      "Пакет решения для менеджера продукта",
      DECISION_SYSTEM_PROMPT,
      buildDecisionUserPrompt(
        data,
        players,
        assumptions,
        aggregatedActors,
        gameAnalysis,
        payoffAssessment
      ),
      signal
    );

    return normalizeDecisionPack(raw, players, fallback);
  } catch (error) {
    if (signal?.aborted || isAbortLikeError(error)) {
      throw new AnalysisCancelledError();
    }

    const errorMessage = getErrorMessage(error);
    appendLivePreview(
      analysisId,
      `\n\n[Пакет решения для менеджера продукта] Не удалось получить отдельный JSON, собрали fallback из Nash-модели: ${errorMessage}\n`,
      {
        phase: "finalizing",
        phaseLabel: "Пакет решения для менеджера продукта",
        llmStatus: "Пакет решения собран из уже рассчитанной Nash-модели",
        error: null,
      },
      false,
    );
    return fallback;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return "Analysis failed";
}

function getAnalysisErrorMessage(
  error: unknown,
  model: string,
  config: (ProviderSettings & { provider: LlmProvider }) | undefined
): string {
  const errorMessage = getErrorMessage(error);
  if (!config || !isLmStudioBaseUrl(config.baseURL) || !/compute error/i.test(errorMessage)) {
    return errorMessage;
  }

  const modelPart = model ? ` на модели «${model}»` : "";
  return `LM Studio вернул Compute error${modelPart}. Проверьте, что выбранная модель полностью загружена в LM Studio и отвечает на простой запрос; если модель сменили, дождитесь загрузки или задайте её явно через LLM_MODEL.`;
}

function shouldUseLocalDebugLLM(): boolean {
  return String(process.env.DEBUG_LOCAL_LLM || "").toLowerCase() === "true";
}

async function testLlmConnection(config: ProviderSettings & { provider: LlmProvider }): Promise<{
  provider: LlmProvider;
  model: string;
  response: string;
}> {
  if (!config.baseURL || !config.apiKey) {
    throw new Error(
      config.provider === "yandex"
        ? "Yandex AI Studio не настроен: укажите API-ключ"
        : "Локальная LLM не настроена: проверьте base URL и API key"
    );
  }

  const client = createOpenAIClient(config);
  const model = await resolveConfiguredModel(config);
  const response = await client.chat.completions.create(
    {
      model,
      messages: [
        {
          role: "system",
          content: "Ответь одним коротким русским словом.",
        },
        {
          role: "user",
          content: "Проверка подключения к LLM. Ответь: готово",
        },
      ],
      temperature: 0,
      max_tokens: 16,
      stream: false,
    },
    { timeout: Math.min(config.timeoutMs, 60_000) },
  ) as any;

  const text = extractChunkText(response?.choices?.[0]?.message?.content).trim();
  return {
    provider: config.provider,
    model,
    response: text || "OK",
  };
}

function findExistingFile(candidates: string[]): string | null {
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function normalizePdfText(value: unknown): string {
  if (value === null || typeof value === "undefined") {
    return "";
  }

  return String(value)
    .replace(/\u2011/g, "-")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\t/g, "  ")
    .trim();
}

function parseAnalysisResultForPdf(item: Analysis): AnalysisResult | ComplexityAnalysisResult | IntegratedAnalysisResult | null {
  if (!item.result) {
    return null;
  }

  try {
    const parsed = JSON.parse(item.result) as Partial<AnalysisResult> & Partial<ComplexityAnalysisResult> & Partial<IntegratedAnalysisResult>;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.analysisMode === "integrated" &&
      parsed.modelKind === "arthur_sandholm_hybrid" &&
      typeof parsed.reachabilityOfNash === "number"
    ) {
      return parsed as IntegratedAnalysisResult;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.analysisMode === "complexity" &&
      Array.isArray(parsed.scenarios)
    ) {
      return parsed as ComplexityAnalysisResult;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.nashScore === "number" &&
      Array.isArray(parsed.equilibria)
    ) {
      return parsed as AnalysisResult;
    }
  } catch {
    return null;
  }

  return null;
}

function isComplexityPdfResult(result: AnalysisResult | ComplexityAnalysisResult | IntegratedAnalysisResult): result is ComplexityAnalysisResult {
  return result.analysisMode === "complexity";
}

function isIntegratedPdfResult(result: AnalysisResult | ComplexityAnalysisResult | IntegratedAnalysisResult): result is IntegratedAnalysisResult {
  return result.analysisMode === "integrated";
}

function getPdfVerdictLabel(value: string): string {
  switch (value) {
    case "launch":
      return "Запускать";
    case "revise":
      return "Доработать";
    case "pause":
      return "Пауза";
    case "kill":
      return "Отменить";
    default:
      return value || "Не указан";
  }
}

function getPdfRiskLabel(value: string): string {
  switch (value) {
    case "low":
      return "Низкий";
    case "medium":
      return "Средний";
    case "high":
      return "Высокий";
    case "critical":
      return "Критический";
    default:
      return value || "Не указан";
  }
}

function getPdfImpactLabel(value: string): string {
  switch (value) {
    case "low":
      return "Низкое влияние";
    case "medium":
      return "Среднее влияние";
    case "high":
      return "Высокое влияние";
    default:
      return value || "Не указано";
  }
}

function getPdfStabilityLabel(value: string): string {
  switch (value) {
    case "stable":
      return "устойчивое";
    case "conditional":
      return "условное";
    case "unstable":
      return "неустойчивое";
    default:
      return value || "не указано";
  }
}

function getPdfPlayerTypeLabel(value: string): string {
  switch (value) {
    case "competitor":
      return "Конкурент";
    case "partner":
      return "Партнёр";
    case "regulator":
      return "Регулятор";
    case "user":
      return "Пользователь";
    case "platform":
      return "Платформа";
    default:
      return "Другое";
  }
}

function getPdfComplexityAgentTypeLabel(value: string): string {
  switch (value) {
    case "team":
      return "Команда";
    case "competitor":
      return "Конкурент";
    case "partner":
      return "Партнёр";
    case "regulator":
      return "Регулятор";
    case "user":
      return "Пользователь";
    case "platform":
      return "Платформа";
    default:
      return "Другое";
  }
}

function getPdfRegimeSeverityLabel(value: string): string {
  switch (value) {
    case "low":
      return "низкая";
    case "medium":
      return "средняя";
    case "high":
      return "высокая";
    default:
      return value || "не указана";
  }
}

function formatPdfDate(value: Analysis["createdAt"]): string {
  if (!value) {
    return "Не указано";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Не указано";
  }

  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPdfDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "Не указано";
  }

  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours} ч ${minutes} мин`;
  }
  if (minutes > 0) {
    return `${minutes} мин ${seconds} сек`;
  }
  return `${seconds} сек`;
}

function formatPdfRecord(record: Record<string, unknown> | undefined, playersById: Map<string, Player>): string {
  if (!record || Object.keys(record).length === 0) {
    return "нет";
  }

  return Object.entries(record)
    .map(([key, value]) => `${playersById.get(key)?.name || key}: ${normalizePdfText(value)}`)
    .join("; ");
}

function formatPdfStateRecord(record: Record<string, unknown> | undefined): string {
  if (!record || Object.keys(record).length === 0) {
    return "нет";
  }

  return Object.entries(record)
    .map(([key, value]) => `${key}: ${normalizePdfText(value)}`)
    .join("; ");
}

function formatPdfStrategies(strategies: Record<string, string> | undefined, playersById: Map<string, Player>): string {
  return formatPdfRecord(strategies, playersById);
}

function registerPdfFonts(doc: PDFKit.PDFDocument) {
  const regular = findExistingFile(PDF_FONT_REGULAR_CANDIDATES);
  const bold = findExistingFile(PDF_FONT_BOLD_CANDIDATES) || regular;

  if (regular) {
    doc.registerFont("Body", regular);
    doc.font("Body");
  } else {
    doc.font("Helvetica");
  }

  if (bold) {
    doc.registerFont("BodyBold", bold);
  }
}

function setPdfFont(doc: PDFKit.PDFDocument, bold = false) {
  const fontName = bold && (doc as unknown as { _fontFamilies?: Record<string, unknown> })._fontFamilies?.BodyBold
    ? "BodyBold"
    : (doc as unknown as { _fontFamilies?: Record<string, unknown> })._fontFamilies?.Body
      ? "Body"
      : "Helvetica";
  doc.font(fontName);
}

function ensurePdfSpace(doc: PDFKit.PDFDocument, minHeight = 48) {
  const bottom = doc.page.height - doc.page.margins.bottom - PDF_FOOTER_RESERVED_HEIGHT;
  if (doc.y + minHeight > bottom) {
    doc.addPage();
  }
}

function addPdfSection(doc: PDFKit.PDFDocument, title: string) {
  ensurePdfSpace(doc, 56);
  doc.moveDown(0.9);
  setPdfFont(doc, true);
  doc.fontSize(10).fillColor("#111111").text(normalizePdfText(title).toUpperCase(), {
    continued: false,
  });
  doc.moveTo(doc.page.margins.left, doc.y + 3)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y + 3)
    .lineWidth(0.4)
    .strokeColor("#d9d9d9")
    .stroke();
  doc.moveDown(0.6);
  setPdfFont(doc);
  doc.fillColor("#111111").fontSize(10);
}

function addPdfParagraph(doc: PDFKit.PDFDocument, text: unknown, options: PDFKit.Mixins.TextOptions = {}) {
  const content = normalizePdfText(text);
  if (!content) {
    return;
  }

  ensurePdfSpace(doc, 30);
  setPdfFont(doc, Boolean(options.continued));
  doc.fontSize(10).fillColor("#111111").text(content, {
    lineGap: 2,
    paragraphGap: 5,
    ...options,
  });
}

function addPdfKeyValues(doc: PDFKit.PDFDocument, rows: Array<[string, unknown]>) {
  rows
    .filter(([, value]) => normalizePdfText(value))
    .forEach(([label, value]) => {
      ensurePdfSpace(doc, 24);
      setPdfFont(doc, true);
      doc.fontSize(10).fillColor("#111111").text(`${normalizePdfText(label)}: `, {
        continued: true,
        lineGap: 2,
      });
      setPdfFont(doc);
      doc.text(normalizePdfText(value), { lineGap: 2 });
    });
  doc.moveDown(0.3);
}

function addPdfList(doc: PDFKit.PDFDocument, items: unknown[] | undefined, numbered = true) {
  (items || [])
    .map((item) => normalizePdfText(item))
    .filter(Boolean)
    .forEach((item, index) => {
      addPdfParagraph(doc, `${numbered ? `${index + 1}.` : "-"} ${item}`);
    });
}

function addPdfSubheading(doc: PDFKit.PDFDocument, title: string) {
  ensurePdfSpace(doc, 28);
  setPdfFont(doc, true);
  doc.fontSize(10).fillColor("#111111").text(normalizePdfText(title), { lineGap: 2 });
  setPdfFont(doc);
}

const PDF_DECISION_TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/Support ticket volume per 100 orders/gi, "Количество обращений в поддержку на 100 заказов"],
  [/Support tickets grow/gi, "Обращения в поддержку растут"],
  [/Checkout conversion rate/gi, "Конверсия чекаута"],
  [/Conversion uplift/gi, "Прирост конверсии"],
  [/Drop-off rate/gi, "Доля отвалов"],
  [/API uptime/gi, "Доступность API"],
  [/error rate/gi, "доля ошибок"],
  [/latency/gi, "задержка"],
  [/fallback mechanism/gi, "резервный механизм"],
  [/fallback/gi, "резервный сценарий"],
  [/per 100 orders/gi, "на 100 заказов"],
];

function localizePdfDecisionText(value: unknown): string {
  return PDF_DECISION_TEXT_REPLACEMENTS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    normalizePdfText(value),
  );
}

function addPdfFooter(doc: PDFKit.PDFDocument) {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    const label = `Агент Нэша - страница ${index + 1} из ${range.count}`;
    const footerY = doc.page.height - doc.page.margins.bottom - 12;
    setPdfFont(doc);
    doc.fontSize(8).fillColor("#777777").text(
      label,
      doc.page.margins.left,
      footerY,
      {
        align: "center",
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        lineBreak: false,
      },
    );
  }
}

function buildPdfFileName(item: Analysis): string {
  const id = Number.isFinite(item.id) ? item.id : "analysis";
  if (item.analysisMode === "integrated") {
    return `integrated-analysis-${id}.pdf`;
  }
  if (item.analysisMode === "complexity") {
    return `complexity-analysis-${id}.pdf`;
  }
  return `nash-analysis-${id}.pdf`;
}

function writeAnalysisPdf(doc: PDFKit.PDFDocument, item: Analysis, result: AnalysisResult) {
  registerPdfFonts(doc);
  const players = result.playersUsed || [];
  const playersById = new Map(players.map((player) => [player.id, player]));
  const recommended = result.recommendedEquilibrium;
  const decisionPack = result.decisionPack;

  doc.fillColor("#111111");
  setPdfFont(doc, true);
  doc.fontSize(14).text(normalizePdfText(item.title), { lineGap: 2 });
  doc.moveDown(0.3);
  setPdfFont(doc);
  doc.fontSize(10).text("Финальный документ анализа для печати", { lineGap: 2 });
  doc.moveDown(0.6);

  addPdfKeyValues(doc, [
    ["Тип", item.type === "strategy" ? "Стратегия" : "Фича"],
    ["Дата анализа", formatPdfDate(item.createdAt)],
    ["Статус решения", getPdfVerdictLabel(result.verdict)],
    ["Тип игры", result.gameType || "Не указан"],
    ["Индекс Нэша", result.nashScore],
    ["Достоверность", result.confidence],
    ["Риск", getPdfRiskLabel(result.riskLevel)],
    ["Игроков", players.length],
    ["Стратегических профилей", result.profiles?.length || 0],
    ["Время анализа", formatPdfDuration(result.runtimeStats?.durationMs)],
    ["Фрагментов ответа", result.runtimeStats?.chunks],
  ]);

  addPdfSection(doc, "Исходные данные");
  addPdfSubheading(doc, "Описание");
  addPdfParagraph(doc, item.description || "Не заполнено");
  addPdfSubheading(doc, "Контекст");
  addPdfParagraph(doc, item.context || "Не заполнено");

  addPdfSection(doc, "Краткая сводка");
  addPdfKeyValues(doc, [
    ["Рекомендованный профиль", recommended?.profileId || "Не найден"],
    ["Равновесий Нэша", result.equilibria?.filter((equilibrium) => equilibrium.isNash).length || 0],
    ["Попарных срезов", result.pairwiseViews?.length || 0],
    ["Проверок чувствительности", result.sensitivityChecks?.length || 0],
  ]);
  if (recommended) {
    addPdfSubheading(doc, "Рекомендованное равновесие");
    addPdfParagraph(doc, recommended.description);
    addPdfKeyValues(doc, [
      ["Стратегии", formatPdfStrategies(recommended.strategies, playersById)],
      ["Выигрыши", formatPdfRecord(recommended.payoffs, playersById)],
    ]);
  }

  addPdfSection(doc, "Состав игры");
  players.forEach((player) => {
    addPdfSubheading(
      doc,
      `${player.name} (${getPdfPlayerTypeLabel(player.type)}${typeof player.weight === "number" ? `, вес ${player.weight}` : ""})`,
    );
    addPdfParagraph(doc, player.incentives);
    addPdfParagraph(doc, `Стратегии: ${(player.strategies || []).join("; ") || "нет"}`);
  });

  addPdfSection(doc, "Сводные участники");
  addPdfList(doc, result.aggregatedActors, false);

  addPdfSection(doc, "Допущения");
  addPdfList(doc, result.assumptions);

  addPdfSection(doc, "Ключевые инсайты");
  addPdfList(doc, result.keyInsights);

  addPdfSection(doc, "Равновесия Нэша");
  (result.equilibria || []).forEach((equilibrium, index) => {
    addPdfSubheading(
      doc,
      `${index + 1}. ${equilibrium.profileId || "Профиль"} - ${getPdfStabilityLabel(equilibrium.stability)}${equilibrium.isNash ? ", Nash" : ""}`,
    );
    addPdfParagraph(doc, equilibrium.description);
    addPdfKeyValues(doc, [
      ["Стратегии", formatPdfStrategies(equilibrium.strategies, playersById)],
      ["Выигрыши", formatPdfRecord(equilibrium.payoffs, playersById)],
    ]);
    if (equilibrium.deviations?.length) {
      addPdfSubheading(doc, "Отклонения");
      addPdfList(
        doc,
        equilibrium.deviations.map((deviation) => {
          const player = playersById.get(deviation.playerId)?.name || deviation.playerId;
          return `${player}: ${deviation.fromStrategy} -> ${deviation.toStrategy}; изменение выигрыша ${deviation.payoffDelta}; ${deviation.profitable ? "выгодно" : "невыгодно"}`;
        }),
        false,
      );
    }
  });

  addPdfSection(doc, "Попарные срезы");
  (result.pairwiseViews || []).forEach((view) => {
    const left = playersById.get(view.players[0])?.name || view.players[0];
    const right = playersById.get(view.players[1])?.name || view.players[1];
    addPdfSubheading(doc, `${left} / ${right}`);
    view.matrix.forEach((row) => {
      row.forEach((cell) => {
        addPdfParagraph(
          doc,
          `${cell.isNash ? "[Nash] " : ""}${formatPdfStrategies(cell.strategies, playersById)}; выигрыши: ${formatPdfRecord(cell.payoffs, playersById)}`,
        );
      });
    });
  });

  addPdfSection(doc, "Проверки чувствительности");
  (result.sensitivityChecks || []).forEach((check, index) => {
    addPdfSubheading(doc, `${index + 1}. ${check.omittedPlayerId} - ${getPdfImpactLabel(check.impact)}`);
    addPdfParagraph(doc, check.note);
  });

  addPdfSection(doc, "Рекомендации");
  addPdfList(doc, result.recommendations);

  addPdfSection(doc, "Угрозы нарушения равновесия");
  addPdfList(doc, result.breakEquilibriumMoves);

  addPdfSection(doc, "Развёрнутый анализ агента");
  addPdfParagraph(doc, result.rawThinking);

  if (decisionPack) {
    addPdfSection(doc, "План действий для продакт-менеджера");
    addPdfKeyValues(doc, [
      ["Решение", getPdfVerdictLabel(decisionPack.recommendedDecision)],
      ["Целевое равновесие", decisionPack.targetEquilibrium || "Не указано"],
      ["Сводка", localizePdfDecisionText(decisionPack.executiveSummary)],
      ["Почему сейчас", localizePdfDecisionText(decisionPack.whyNow)],
    ]);

    addPdfSubheading(doc, "Стратегические ходы");
    (decisionPack.topStrategicMoves || []).forEach((move) => {
      addPdfParagraph(
        doc,
        `P${move.priority}. ${localizePdfDecisionText(move.title)}; цель: ${move.targetPlayerId === "system" ? "Система игры" : playersById.get(move.targetPlayerId)?.name || move.targetPlayerId}; усилие ${move.effort}; +${move.expectedNashScoreDelta} к индексу; уверенность ${Math.round(move.confidence)}.`,
      );
      addPdfParagraph(doc, localizePdfDecisionText(move.objective));
      addPdfParagraph(doc, localizePdfDecisionText(move.changesIncentiveHow));
      if (move.expectedPayoffDelta && Object.keys(move.expectedPayoffDelta).length) {
        addPdfParagraph(doc, `Изменение выигрышей: ${formatPdfRecord(move.expectedPayoffDelta, playersById)}`);
      }
    });

    addPdfSubheading(doc, "План проверки");
    (decisionPack.experimentPlan || []).forEach((experiment, index) => {
      addPdfParagraph(doc, `E${index + 1}. ${localizePdfDecisionText(experiment.hypothesis)} (${experiment.timebox})`);
      addPdfKeyValues(doc, [
        ["Метрика", localizePdfDecisionText(experiment.metric)],
        ["Ограничитель", localizePdfDecisionText(experiment.guardrailMetric)],
        ["Успех", localizePdfDecisionText(experiment.successCriterion)],
        ["Остановка", localizePdfDecisionText(experiment.killCriterion)],
      ]);
    });

    addPdfSubheading(doc, "Ограничители запуска");
    addPdfList(doc, decisionPack.launchGuardrails.map(localizePdfDecisionText));

    addPdfSubheading(doc, "Сценарии контрходов");
    (decisionPack.counterMovePlaybook || []).forEach((item, index) => {
      addPdfParagraph(
        doc,
        `${index + 1}. ${localizePdfDecisionText(item.threat)}; сигнал: ${localizePdfDecisionText(item.earlySignal)}; ответ: ${localizePdfDecisionText(item.mitigation)}`,
      );
    });

    addPdfSubheading(doc, "Открытые вопросы");
    addPdfList(doc, decisionPack.openQuestions.map(localizePdfDecisionText));
  }

  addPdfSection(doc, "Все стратегические профили");
  (result.profiles || []).forEach((profile) => {
    addPdfSubheading(doc, `${profile.id}${profile.feasible ? "" : " - infeasible"}`);
    addPdfKeyValues(doc, [
      ["Стратегии", formatPdfStrategies(profile.selections, playersById)],
      ["Выигрыши", formatPdfRecord(profile.payoffs, playersById)],
      ["Вывод", profile.summary],
    ]);
  });

  addPdfFooter(doc);
}

function writeComplexityAnalysisPdf(doc: PDFKit.PDFDocument, item: Analysis, result: ComplexityAnalysisResult) {
  registerPdfFonts(doc);

  doc.fillColor("#111111");
  setPdfFont(doc, true);
  doc.fontSize(14).text(normalizePdfText(item.title), { lineGap: 2 });
  doc.moveDown(0.3);
  setPdfFont(doc);
  doc.fontSize(10).text("Финальный документ анализа в логике экономики сложности", { lineGap: 2 });
  doc.moveDown(0.6);

  addPdfKeyValues(doc, [
    ["Тип", item.type === "strategy" ? "Стратегия" : "Фича"],
    ["Режим анализа", "Экономика сложности"],
    ["Дата анализа", formatPdfDate(item.createdAt)],
    ["Статус решения", result.verdictLabel || getPdfVerdictLabel(result.verdict)],
    ["Устойчивость к сбоям", result.resilienceScore],
    ["Способность к адаптации", result.adaptationCapacity],
    ["Риск захвата траектории", result.lockInRisk],
    ["Риск каскадного сбоя", result.cascadeRisk],
    ["Пространство будущих манёвров", result.optionalityScore],
    ["Достоверность", result.confidence],
    ["Игроков", result.agentsUsed?.length || 0],
    ["Сценариев", result.scenarios?.length || 0],
    ["Время анализа", formatPdfDuration(result.runtimeStats?.durationMs)],
    ["Фрагментов ответа", result.runtimeStats?.chunks],
  ]);

  addPdfSection(doc, "Исходные данные");
  addPdfSubheading(doc, "Описание");
  addPdfParagraph(doc, item.description || "Не заполнено");
  addPdfSubheading(doc, "Контекст");
  addPdfParagraph(doc, item.context || "Не заполнено");

  addPdfSection(doc, "Краткая сводка");
  addPdfParagraph(doc, result.executiveSummary);

  addPdfSection(doc, "Адаптивные игроки");
  (result.agentsUsed || []).forEach((agent) => {
    addPdfSubheading(
      doc,
      `${agent.name} (${getPdfComplexityAgentTypeLabel(agent.type)}, вес ${agent.weight})`,
    );
    addPdfParagraph(doc, `Цели: ${(agent.goals || []).join("; ") || "нет"}`);
    addPdfParagraph(doc, `Вероятные ходы: ${(agent.likelyMoves || []).join("; ") || "нет"}`);
    if (agent.adaptationRules?.length) {
      addPdfParagraph(
        doc,
        `Правила адаптации: ${agent.adaptationRules.map((rule) => rule.label).join("; ")}`,
      );
    }
  });

  addPdfSection(doc, "Переменные состояния");
  (result.stateVariables || []).forEach((variable) => {
    addPdfSubheading(doc, `${variable.name} - старт ${variable.initialValue}`);
    addPdfParagraph(doc, variable.description);
  });

  addPdfSection(doc, "Обратные связи");
  (result.feedbackLoops || []).forEach((loop) => {
    addPdfSubheading(doc, `${loop.label} - ${loop.type === "reinforcing" ? "усиливающая" : "сдерживающая"}`);
    addPdfParagraph(doc, loop.description);
    if (loop.impacts && Object.keys(loop.impacts).length) {
      addPdfParagraph(doc, `Влияния: ${formatPdfStateRecord(loop.impacts)}`);
    }
  });

  addPdfSection(doc, "Пороговые переломы");
  (result.tippingPoints || []).forEach((point) => {
    addPdfSubheading(doc, `${point.label} - порог ${point.threshold}`);
    addPdfParagraph(doc, point.consequence);
  });

  addPdfSection(doc, "Зависимости от ранних событий");
  (result.pathDependencies || []).forEach((dependency) => {
    addPdfSubheading(doc, `${dependency.id} - обратимость: ${dependency.reversibility}`);
    addPdfParagraph(doc, dependency.earlyCondition);
    addPdfParagraph(doc, dependency.laterEffect);
  });

  addPdfSection(doc, "Возможные вмешательства");
  (result.interventions || []).forEach((intervention) => {
    addPdfSubheading(doc, intervention.label);
    addPdfParagraph(doc, intervention.description);
    addPdfParagraph(doc, `Влияния: ${formatPdfStateRecord(intervention.intendedImpacts)}`);
    if (intervention.tradeoffs?.length) {
      addPdfParagraph(doc, `Компромиссы: ${intervention.tradeoffs.join("; ")}`);
    }
  });

  addPdfSection(doc, "Сценарии симуляции");
  (result.scenarios || []).forEach((scenario) => {
    addPdfSubheading(doc, scenario.label);
    addPdfParagraph(doc, scenario.description);
    addPdfParagraph(doc, scenario.outcomeSummary);
    addPdfParagraph(doc, `Финальное состояние: ${formatPdfStateRecord(scenario.finalState)}`);
    (scenario.steps || []).forEach((step) => {
      const events = step.events?.length ? step.events.join("; ") : "без сильных изменений";
      const signals = step.regimeSignals?.length ? step.regimeSignals.join("; ") : "нет пороговых сигналов";
      addPdfParagraph(doc, `Шаг ${step.step}: ${events}. Сигналы: ${signals}.`);
    });
  });

  addPdfSection(doc, "Режимы системы");
  (result.dominantRegimes || []).forEach((regime) => {
    addPdfSubheading(doc, `${regime.label} - важность ${getPdfRegimeSeverityLabel(regime.severity)}`);
    addPdfList(doc, regime.evidence, false);
  });

  addPdfSection(doc, "Ранние сигналы");
  addPdfList(doc, result.earlySignals);

  addPdfSection(doc, "Триггеры смены режима");
  addPdfList(doc, result.regimeShiftTriggers);

  addPdfSection(doc, "Ключевые выводы");
  addPdfList(doc, result.keyInsights);

  addPdfSection(doc, "Рекомендации");
  addPdfList(doc, result.recommendations);

  addPdfSection(doc, "Развёрнутый анализ агента");
  addPdfParagraph(doc, result.rawThinking);

  addPdfFooter(doc);
}

function writeIntegratedAnalysisPdf(doc: PDFKit.PDFDocument, item: Analysis, result: IntegratedAnalysisResult) {
  registerPdfFonts(doc);

  const basinLabel =
    result.basinOfAttraction === "wide"
      ? "широкая"
      : result.basinOfAttraction === "narrow"
        ? "узкая"
        : "фрагментированная";
  const agreementLabel =
    result.agreementLevel === "high"
      ? "высокая"
      : result.agreementLevel === "medium"
        ? "средняя"
        : "низкая";

  doc.fillColor("#111111");
  setPdfFont(doc, true);
  doc.fontSize(14).text(normalizePdfText(item.title), { lineGap: 2 });
  doc.moveDown(0.3);
  setPdfFont(doc);
  doc.fontSize(10).text("Совмещённый документ анализа: равновесие Нэша + экономика сложности", { lineGap: 2 });
  doc.moveDown(0.6);

  addPdfKeyValues(doc, [
    ["Тип", item.type === "strategy" ? "Стратегия" : "Фича"],
    ["Режим анализа", "Совмещённый анализ"],
    ["Дата анализа", formatPdfDate(item.createdAt)],
    ["Итоговое решение", result.decisionLabel],
    ["Статическая устойчивость", result.staticStabilityScore],
    ["Динамическая устойчивость", result.dynamicStabilityScore],
    ["Достижимость равновесия", result.reachabilityOfNash],
    ["Давление адаптации", result.adaptationPressure],
    ["Область притяжения", basinLabel],
    ["Согласованность подходов", agreementLabel],
    ["Достоверность", result.confidence],
    ["Время анализа", formatPdfDuration(result.runtimeStats?.durationMs)],
    ["Фрагментов ответа", result.runtimeStats?.chunks],
  ]);

  addPdfSection(doc, "Исходные данные");
  addPdfSubheading(doc, "Описание");
  addPdfParagraph(doc, item.description || "Не заполнено");
  addPdfSubheading(doc, "Контекст");
  addPdfParagraph(doc, item.context || "Не заполнено");

  addPdfSection(doc, "Сводный вывод");
  addPdfParagraph(doc, result.executiveSummary);
  addPdfParagraph(doc, result.finalRecommendation);

  addPdfSection(doc, "Где подходы согласны");
  addPdfList(doc, result.whereAnalysesAgree);

  addPdfSection(doc, "Противоречия");
  addPdfList(doc, result.contradictions);

  addPdfSection(doc, "Продуктовые следствия");
  addPdfList(doc, result.productImplications);

  addPdfSection(doc, "Что изменить до разработки");
  addPdfList(doc, result.preDevelopmentChanges);

  addPdfSection(doc, "Дизайн пилота");
  addPdfList(doc, result.pilotDesign);

  addPdfSection(doc, "Ранние сигналы");
  addPdfList(doc, result.earlySignalsToWatch);

  addPdfSection(doc, "Слой равновесия Нэша");
  addPdfKeyValues(doc, [
    ["Индекс Нэша", result.nash.nashScore],
    ["Риск", getPdfRiskLabel(result.nash.riskLevel)],
    ["Решение", getPdfVerdictLabel(result.nash.verdict)],
    ["Игроков", result.nash.playersUsed?.length || 0],
    ["Профилей", result.nash.profiles?.length || 0],
  ]);
  addPdfList(doc, result.nash.keyInsights);

  addPdfSection(doc, "Слой экономики сложности");
  addPdfKeyValues(doc, [
    ["Устойчивость к сбоям", result.complexity.resilienceScore],
    ["Способность к адаптации", result.complexity.adaptationCapacity],
    ["Риск захвата траектории", result.complexity.lockInRisk],
    ["Риск каскадного сбоя", result.complexity.cascadeRisk],
    ["Сценариев", result.complexity.scenarios?.length || 0],
  ]);
  addPdfList(doc, result.complexity.keyInsights);

  addPdfSection(doc, "Математическая интерпретация");
  addPdfParagraph(doc, result.rawThinking);

  addPdfFooter(doc);
}

function normalizeAnalysisModeInput(value: unknown): AnalysisMode | undefined {
  if (value === "complexity" || value === "nash" || value === "integrated") {
    return value;
  }

  return undefined;
}

function normalizeCreateAnalysisRequestBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }

  const record = body as Record<string, unknown>;
  const analysisMode =
    normalizeAnalysisModeInput(record.analysisMode) ||
    normalizeAnalysisModeInput(record.analysis_mode) ||
    normalizeAnalysisModeInput(record.mode);

  if (!analysisMode) {
    return body;
  }

  return {
    ...record,
    analysisMode,
  };
}

function upgradeIntegratedArticleIfNeeded(item: Analysis): Analysis {
  if (!item.result || item.status !== "done") {
    return item;
  }

  try {
    const parsed = JSON.parse(item.result) as Partial<IntegratedAnalysisResult>;
    const rawThinking = typeof parsed.rawThinking === "string" ? parsed.rawThinking.trim() : "";

    if (
      parsed.analysisMode !== "integrated" ||
      parsed.modelKind !== "arthur_sandholm_hybrid" ||
      typeof parsed.reachabilityOfNash !== "number" ||
      rawThinking.length >= 3000
    ) {
      return item;
    }

    const { rawThinking: _rawThinking, ...withoutRawThinking } = parsed as IntegratedAnalysisResult;
    const upgradedResult: IntegratedAnalysisResult = {
      ...(withoutRawThinking as Omit<IntegratedAnalysisResult, "rawThinking">),
      rawThinking: buildFallbackIntegratedArticle(
        {
          title: item.title,
          description: item.description,
          context: item.context,
        },
        withoutRawThinking as Omit<IntegratedAnalysisResult, "rawThinking">,
      ),
    };
    return storage.updateAnalysisResult(item.id, JSON.stringify(upgradedResult), item.status) || {
      ...item,
      result: JSON.stringify(upgradedResult),
    };
  } catch {
    return item;
  }
}

export function registerRoutes(_httpServer: Server, app: Express) {
  const handleDeleteAnalysis = (req: Request, res: Response) => {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(rawId, 10);
    const item = storage.getAnalysis(id);
    if (!item) {
      return res.status(404).json({ error: "Not found" });
    }

    if (!isTerminalAnalysisStatus(item.status)) {
      return res.status(409).json({ error: "Нельзя удалить активный анализ" });
    }

    const deleted = storage.deleteAnalysis(id);
    disposeAnalysisArtifacts(id);
    return res.json(deleted || item);
  };

  // ─── List analyses ─────────────────────────────────────────────────────────
  app.get("/api/analyses", (_req, res) => {
    const list = storage.listAnalyses();
    res.json(list);
  });

  // ─── Get single analysis ───────────────────────────────────────────────────
  app.get("/api/analyses/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const item = storage.getAnalysis(id);
    if (!item) return res.status(404).json({ error: "Not found" });
    return res.json(upgradeIntegratedArticleIfNeeded(item));
  });

  // ─── Create + run analysis ─────────────────────────────────────────────────
  app.post("/api/analyses", async (req, res) => {
    const parsed = insertAnalysisSchema.safeParse(normalizeCreateAnalysisRequestBody(req.body));
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const analysis = storage.createAnalysis(parsed.data);
    console.info(`[analysis] created ${analysis.id} mode=${parsed.data.analysisMode}`);
    res.json(analysis);

    // Run LLM analysis in background
    runAnalysis(analysis.id, parsed.data).catch(console.error);
  });

  app.post("/api/analyses/:id/stop", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const item = storage.getAnalysis(id);
    if (!item) {
      return res.status(404).json({ error: "Not found" });
    }

    if (item.status === "cancelled") {
      return res.json(item);
    }

    if (isTerminalAnalysisStatus(item.status)) {
      return res.status(409).json({ error: "Analysis is already finished" });
    }

    const updated = cancelAnalysisExecution(id);
    return res.json(updated || storage.getAnalysis(id));
  });

  app.post("/api/analyses/:id/check-llm", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const item = storage.getAnalysis(id);
    if (!item) {
      return res.status(404).json({ error: "Not found" });
    }

    if (isTerminalAnalysisStatus(item.status)) {
      return res.status(409).json({ error: "Analysis is already finished" });
    }

    const llmConfig = analysisRuntimeConfigs.get(id) || getActiveLlmConfig();
    if (!isLmStudioBaseUrl(llmConfig.baseURL)) {
      const message = "Проверка загруженной LLM доступна только для LM Studio.";
      updateLiveProgress(id, {
        requiresLlmCheck: false,
        llmCheckMessage: null,
        llmStatus: message,
        error: null,
      });
      return res.status(400).json({ error: message });
    }

    try {
      const loadedModel = await resolveLoadedLmStudioModel(llmConfig.baseURL, llmConfig.apiKey || "lm-studio");
      if (!loadedModel) {
        throw new Error(
          "В LM Studio нет загруженной LLM. Загрузите модель в LM Studio и нажмите кнопку ещё раз."
        );
      }

      const resumed = resolveLlmCheckWaiter(id, loadedModel);
      analysisRuntimeModels.set(id, loadedModel);
      updateLiveProgress(id, {
        llmStatus: resumed
          ? `LLM загружена: ${loadedModel}. Повторяем запрос…`
          : `LLM загружена: ${loadedModel}. Активного ожидания повтора сейчас нет.`,
        requiresLlmCheck: false,
        llmCheckMessage: null,
        error: null,
      });

      return res.json({ ok: true, model: loadedModel, resumed });
    } catch (error) {
      const message = getErrorMessage(error);
      updateLiveProgress(id, {
        llmStatus: message,
        requiresLlmCheck: true,
        llmCheckMessage: message,
        error: null,
      });
      return res.status(409).json({ error: message });
    }
  });

  app.post("/api/analyses/:id/delete", handleDeleteAnalysis);
  app.delete("/api/analyses/:id", handleDeleteAnalysis);

  app.get("/api/analyses/:id/pdf", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const item = storage.getAnalysis(id);
    if (!item) {
      return res.status(404).json({ error: "Not found" });
    }
    const upgradedItem = upgradeIntegratedArticleIfNeeded(item);

    const result = parseAnalysisResultForPdf(upgradedItem);
    if (!result) {
      return res.status(409).json({ error: "PDF доступен только после успешного завершения анализа" });
    }

    const filename = buildPdfFileName(upgradedItem);
    const encodedFilename = encodeURIComponent(filename);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"; filename*=UTF-8''${encodedFilename}`,
    );

    const doc = new PDFDocument({
      size: "A4",
      margin: 42,
      bufferPages: true,
      info: {
        Title: item.title,
        Author: "Агент Нэша",
        Subject: isIntegratedPdfResult(result)
          ? "Integrated Nash and complexity analysis"
          : isComplexityPdfResult(result)
            ? "Complexity analysis"
            : "Nash analysis",
      },
    });

    doc.on("error", (error) => {
      console.error("[pdf] generation failed:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: getErrorMessage(error) });
      } else {
        res.end();
      }
    });

    doc.pipe(res);
    if (isIntegratedPdfResult(result)) {
      writeIntegratedAnalysisPdf(doc, upgradedItem, result);
    } else if (isComplexityPdfResult(result)) {
      writeComplexityAnalysisPdf(doc, upgradedItem, result);
    } else {
      writeAnalysisPdf(doc, upgradedItem, result);
    }
    doc.end();
  });

  // ─── SSE: stream status updates ───────────────────────────────────────────
  app.get("/api/analyses/:id/stream", (req, res) => {
    const id = parseInt(req.params.id, 10);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendSnapshot = () => {
      const item = storage.getAnalysis(id);
      if (!item) {
        return false;
      }

      const progress = analysisLiveProgress.get(id) || null;
      const effectiveStatus =
        progress?.phase === "done" || progress?.phase === "error" || progress?.phase === "cancelled"
          ? progress.phase
          : item.status;
      const effectiveResult =
        (effectiveStatus === "error" || effectiveStatus === "cancelled") && !item.result && progress?.error
          ? JSON.stringify({ error: progress.error })
          : item.result;

      res.write(`data: ${JSON.stringify({ status: effectiveStatus, result: effectiveResult, progress })}\n\n`);
      return effectiveStatus === "done" || effectiveStatus === "error" || effectiveStatus === "cancelled";
    };

    if (sendSnapshot()) {
      setTimeout(() => res.end(), 500);
      return;
    }

    const interval = setInterval(() => {
      const isTerminal = sendSnapshot();
      if (isTerminal === false && !storage.getAnalysis(id)) {
        clearInterval(interval);
        res.end();
        return;
      }

      if (isTerminal) {
        clearInterval(interval);
        setTimeout(() => res.end(), 500);
      }
    }, 400);

    req.on("close", () => clearInterval(interval));
  });

  // ─── Health / settings ────────────────────────────────────────────────────
  app.get("/api/settings", (_req, res) => {
    return res.json(toPublicAppSettings(readAppSettings()));
  });

  app.put("/api/settings", (req, res) => {
    try {
      const next = writeAppSettings(mergeSettingsPatch(readAppSettings(), req.body));
      return res.json(toPublicAppSettings(next));
    } catch (error) {
      return res.status(400).json({ error: getErrorMessage(error) });
    }
  });

  app.post("/api/settings/test-llm", async (_req, res) => {
    try {
      const result = await testLlmConnection(getActiveLlmConfig());
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(409).json({ ok: false, error: getErrorMessage(error) });
    }
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
}

// ─── LLM Runner ──────────────────────────────────────────────────────────────
interface NashCoreProgressStepIds {
  setup: AnalysisProgressStepId;
  build: AnalysisProgressStepId;
  score: AnalysisProgressStepId;
  equilibrium: AnalysisProgressStepId;
  article: AnalysisProgressStepId;
  decision: AnalysisProgressStepId;
}

interface ComplexityCoreProgressStepIds {
  setup: AnalysisProgressStepId;
  scenarios: AnalysisProgressStepId;
  simulation: AnalysisProgressStepId;
  regimes: AnalysisProgressStepId;
  article: AnalysisProgressStepId;
  decision: AnalysisProgressStepId;
}

const DEFAULT_NASH_CORE_PROGRESS_STEPS: NashCoreProgressStepIds = {
  setup: "setup_players",
  build: "build_profiles",
  score: "score_profiles",
  equilibrium: "compute_equilibrium",
  article: "agent_article",
  decision: "decision_pack",
};

const INTEGRATED_NASH_PROGRESS_STEPS: NashCoreProgressStepIds = {
  setup: "integrated_nash_setup",
  build: "integrated_nash_profiles",
  score: "integrated_nash_payoffs",
  equilibrium: "integrated_nash_equilibrium",
  article: "integrated_nash_article",
  decision: "integrated_nash_decision",
};

const DEFAULT_COMPLEXITY_CORE_PROGRESS_STEPS: ComplexityCoreProgressStepIds = {
  setup: "setup_players",
  scenarios: "build_profiles",
  simulation: "score_profiles",
  regimes: "compute_equilibrium",
  article: "agent_article",
  decision: "decision_pack",
};

const INTEGRATED_COMPLEXITY_PROGRESS_STEPS: ComplexityCoreProgressStepIds = {
  setup: "integrated_complexity_setup",
  scenarios: "integrated_complexity_scenarios",
  simulation: "integrated_complexity_simulation",
  regimes: "integrated_complexity_regimes",
  article: "integrated_complexity_article",
  decision: "integrated_complexity_decision",
};

async function runNashAnalysisCore(
  id: number,
  data: { type: string; title: string; description: string; players: string; context: string },
  client: OpenAI,
  model: string,
  hintedPlayers: Player[],
  signal: AbortSignal,
  stepIds: NashCoreProgressStepIds = DEFAULT_NASH_CORE_PROGRESS_STEPS,
): Promise<AnalysisResult> {
  activateAnalysisStep(id, stepIds.setup, {
    phase: "setup",
    phaseLabel: "Выделение игроков и границ игры",
    llmStatus: "Определяем ключевых игроков, стимулы и границы игры",
  });
  const strategicSetup = await inferStrategicSetup(client, id, model, data, hintedPlayers, signal);
  completeAnalysisStep(id, stepIds.setup);
  throwIfAborted(signal);

  activateAnalysisStep(id, stepIds.build, {
    phase: "setup",
    phaseLabel: "Генерация стратегий, допущений и профилей",
    llmStatus: "Строим дерево стратегических профилей",
  });
  const baseProfiles = buildStrategyProfiles(strategicSetup.players);
  completeAnalysisStep(id, stepIds.build);
  activateAnalysisStep(id, stepIds.score, {
    phase: "payoff",
    phaseLabel: "Оценка стратегических профилей",
    llmStatus: `Подготовили ${baseProfiles.length} профилей для оценки`,
    profileCount: baseProfiles.length,
    profileProcessedCount: 0,
  });
  updateLiveProgress(id, {
    phase: "payoff",
    phaseLabel: "Оценка стратегических профилей",
    llmStatus: `Подготовили ${baseProfiles.length} профилей для оценки`,
    profileCount: baseProfiles.length,
    profileProcessedCount: 0,
  });
  const payoffAssessment = await assessProfiles(
    client,
    id,
    model,
    data,
    strategicSetup.players,
    strategicSetup.assumptions,
    strategicSetup.caseFrame,
    strategicSetup.aggregatedActors,
    baseProfiles,
    signal,
  );
  completeAnalysisStep(id, stepIds.score);
  throwIfAborted(signal);

  activateAnalysisStep(id, stepIds.equilibrium, {
    phase: "finalizing",
    phaseLabel: "Формирование результата Нэша",
    llmStatus: "Ищем равновесия Нэша и собираем статический слой",
  });

  const confidence = clamp(
    payoffAssessment.confidence +
      Math.min(strategicSetup.players.length, 5) +
      (strategicSetup.aggregatedActors.length > 0 ? 3 : 0),
    20,
    95,
  );

  const gameAnalysis = analyzeProfiles(
    strategicSetup.players,
    payoffAssessment.profiles,
    confidence,
  );
  completeAnalysisStep(id, stepIds.equilibrium);

  activateAnalysisStep(id, stepIds.article, {
    phase: "finalizing",
    phaseLabel: "Развёрнутый анализ Нэша",
    llmStatus: "Генерируем объяснение механики игры",
  });
  const agentArticle = await generateAgentArticle(
    client,
    id,
    model,
    data,
    strategicSetup.players,
    strategicSetup.assumptions,
    strategicSetup.aggregatedActors,
    gameAnalysis,
    {
      profiles: payoffAssessment.profiles,
      confidence,
      gameType: payoffAssessment.gameType,
      keyInsights: payoffAssessment.keyInsights,
      breakEquilibriumMoves: payoffAssessment.breakEquilibriumMoves,
      recommendations: payoffAssessment.recommendations,
      sensitivityChecks: payoffAssessment.sensitivityChecks,
    },
    signal,
  );
  completeAnalysisStep(id, stepIds.article);
  throwIfAborted(signal);

  activateAnalysisStep(id, stepIds.decision, {
    phase: "finalizing",
    phaseLabel: "Пакет решения по равновесию",
    llmStatus: "Собираем стратегические ходы, проверки и ограничители запуска",
  });
  const decisionPack = await generateDecisionPack(
    client,
    id,
    model,
    data,
    strategicSetup.players,
    strategicSetup.assumptions,
    strategicSetup.aggregatedActors,
    gameAnalysis,
    {
      confidence,
      gameType: payoffAssessment.gameType,
      keyInsights: payoffAssessment.keyInsights,
      breakEquilibriumMoves: payoffAssessment.breakEquilibriumMoves,
      recommendations: payoffAssessment.recommendations,
      sensitivityChecks: payoffAssessment.sensitivityChecks,
    },
    signal,
  );
  completeAnalysisStep(id, stepIds.decision);
  throwIfAborted(signal);

  const pairwiseViews = buildPairwiseViews(
    strategicSetup.players,
    payoffAssessment.profiles,
    gameAnalysis.equilibria,
    gameAnalysis.recommendedEquilibrium,
  );
  const primaryPairwise = pairwiseViews[0];

  return {
    analysisMode: "nash",
    playersUsed: strategicSetup.players,
    aggregatedActors: strategicSetup.aggregatedActors,
    assumptions: uniqueStrings([
      ...strategicSetup.assumptions,
      strategicSetup.caseFrame ? `Фрейм игры: ${strategicSetup.caseFrame}` : "",
    ]),
    profiles: payoffAssessment.profiles,
    confidence,
    pairwiseViews,
    sensitivityChecks: payoffAssessment.sensitivityChecks,
    equilibria: gameAnalysis.equilibria,
    recommendedEquilibrium: gameAnalysis.recommendedEquilibrium,
    nashScore: gameAnalysis.nashScore,
    riskLevel: gameAnalysis.riskLevel,
    verdict: gameAnalysis.verdict,
    gameType: payoffAssessment.gameType,
    keyInsights: payoffAssessment.keyInsights,
    breakEquilibriumMoves: payoffAssessment.breakEquilibriumMoves,
    recommendations: payoffAssessment.recommendations,
    decisionPack,
    runtimeStats: buildRuntimeStats(id),
    payoffMatrix: primaryPairwise?.matrix || [],
    matrixPlayers: primaryPairwise ? [...primaryPairwise.players] : [],
    matrixStrategies: primaryPairwise?.matrixStrategies || {},
    rawThinking: agentArticle,
  };
}

async function runComplexityAnalysisCore(
  id: number,
  data: { type: string; title: string; description: string; context: string },
  client: OpenAI,
  model: string,
  signal: AbortSignal,
  stepIds: ComplexityCoreProgressStepIds = DEFAULT_COMPLEXITY_CORE_PROGRESS_STEPS,
): Promise<ComplexityAnalysisResult> {
  activateAnalysisStep(id, stepIds.setup, {
    phase: "setup",
    phaseLabel: "Сборка адаптивной модели системы",
    llmStatus: "Выделяем игроков, переменные состояния и обратные связи",
  });
  const setup = await inferComplexitySetup(client, id, model, data, signal);
  completeAnalysisStep(id, stepIds.setup);
  throwIfAborted(signal);

  activateAnalysisStep(id, stepIds.scenarios, {
    phase: "setup",
    phaseLabel: "Подготовка сценариев",
    llmStatus: "Формируем базовый сценарий, сценарий ускоренного роста и стресс-сценарий",
    profileCount: setup.scenarioDefinitions.length,
    profileProcessedCount: 0,
  });
  completeAnalysisStep(id, stepIds.scenarios);

  activateAnalysisStep(id, stepIds.simulation, {
    phase: "payoff",
    phaseLabel: "Прогон адаптивной симуляции",
    llmStatus: "Сервер детерминированно прогоняет сценарии без обращения к LLM на каждом шаге",
    profileCount: setup.scenarioDefinitions.length,
    profileProcessedCount: 0,
  });
  appendPhaseHeader(id, "Прогон адаптивной симуляции");
  const simulation = simulateComplexitySystem(setup);
  appendLivePreview(
    id,
    `Симуляция завершена: ${simulation.scenarios.length} сценария, ${simulation.scenarios[0]?.steps.length || 0} шагов.\n`,
    {
      phase: "payoff",
      phaseLabel: "Прогон адаптивной симуляции",
      llmStatus: "Сценарии рассчитаны, ищем режимы системы",
      profileCount: setup.scenarioDefinitions.length,
      profileProcessedCount: setup.scenarioDefinitions.length,
    },
    false,
  );
  completeAnalysisStep(id, stepIds.simulation);
  throwIfAborted(signal);

  activateAnalysisStep(id, stepIds.regimes, {
    phase: "finalizing",
    phaseLabel: "Поиск режимов системы",
    llmStatus: "Определяем пороговые переломы, каскадные риски и захват траектории",
  });
  completeAnalysisStep(id, stepIds.regimes);

  activateAnalysisStep(id, stepIds.article, {
    phase: "finalizing",
    phaseLabel: "Развёрнутый анализ траектории системы",
    llmStatus: "Генерируем объяснение динамики системы для менеджера продукта",
  });
  const rawThinking = await generateComplexityArticle(client, id, model, data, setup, simulation, signal);
  completeAnalysisStep(id, stepIds.article);
  throwIfAborted(signal);

  activateAnalysisStep(id, stepIds.decision, {
    phase: "finalizing",
    phaseLabel: "Пакет решения по адаптивной траектории",
    llmStatus: "Собираем вердикт, ранние сигналы и рекомендации",
  });
  const decision = await generateComplexityDecisionPack(client, id, model, data, setup, simulation, signal);
  completeAnalysisStep(id, stepIds.decision);
  throwIfAborted(signal);

  const result = composeComplexityResult(
    setup.title || data.title,
    setup,
    simulation,
    decision,
    rawThinking,
    buildRuntimeStats(id),
  );

  assertComplexityGuardrails(result);
  return result;
}

async function runComplexityAnalysis(
  id: number,
  data: { type: string; title: string; description: string; context: string },
  client: OpenAI,
  model: string,
  signal: AbortSignal,
) {
  const result = await runComplexityAnalysisCore(id, data, client, model, signal);
  persistAnalysisResult(id, JSON.stringify(result), "done");
  completeAllAnalysisSteps(id);
  finalizeLiveProgress(id, "done");
}

async function runIntegratedAnalysis(
  id: number,
  data: { type: string; title: string; description: string; players: string; context: string },
  client: OpenAI,
  model: string,
  hintedPlayers: Player[],
  signal: AbortSignal,
) {
  appendPhaseHeader(id, "Статический слой: равновесие Нэша");
  const nash = await runNashAnalysisCore(id, data, client, model, hintedPlayers, signal, INTEGRATED_NASH_PROGRESS_STEPS);
  throwIfAborted(signal);

  appendPhaseHeader(id, "Динамический слой: экономика сложности");
  const complexity = await runComplexityAnalysisCore(id, data, client, model, signal, INTEGRATED_COMPLEXITY_PROGRESS_STEPS);
  throwIfAborted(signal);

  activateAnalysisStep(id, "integrated_synthesis", {
    phase: "finalizing",
    phaseLabel: "Совмещённый вывод",
    llmStatus: "Считаем достижимость равновесия через адаптивную динамику",
  });
  appendPhaseHeader(id, "Совмещение Нэша и экономики сложности");
  const result = composeIntegratedAnalysisResult(data, nash, complexity, buildRuntimeStats(id));
  appendLivePreview(
    id,
    `${result.executiveSummary}\n`,
    {
      phase: "finalizing",
      phaseLabel: "Совмещённый вывод",
      llmStatus: result.finalRecommendation,
    },
    false,
  );
  updateLiveProgress(id, {
    phase: "finalizing",
    phaseLabel: "Развёрнутый совмещённый вывод",
    llmStatus: "Готовим объясняющую статью для руководителя",
    activeStepId: "integrated_synthesis",
  });
  result.rawThinking = await generateIntegratedArticle(client, id, model, data, result, signal);
  result.runtimeStats = buildRuntimeStats(id);
  completeAnalysisStep(id, "integrated_synthesis");

  persistAnalysisResult(id, JSON.stringify(result), "done");
  completeAllAnalysisSteps(id);
  finalizeLiveProgress(id, "done");
}

async function runAnalysis(
  id: number,
  data: { type: string; analysisMode?: AnalysisMode; title: string; description: string; players: string; context: string }
) {
  const initialAnalysis = storage.getAnalysis(id);
  if (!initialAnalysis || initialAnalysis.status === "cancelled") {
    if (initialAnalysis?.status === "cancelled") {
      finalizeLiveProgress(id, "cancelled", "Анализ остановлен пользователем");
    }
    return;
  }

  const controller = new AbortController();
  activeAnalysisControllers.set(id, controller);
  let activeModel = "";

  try {
    throwIfAborted(controller.signal);
    analysisLiveProgress.set(id, buildInitialLiveProgress());
    updateLiveProgress(id, {
      phase: "queued",
      phaseLabel: "Анализ запущен",
      llmStatus: "Готовим запрос к модели",
      activeStepId: "prepare_request",
      completedStepIds: [],
      error: null,
      previewText: "",
    });

    if (storage.getAnalysis(id)?.status === "cancelled") {
      finalizeLiveProgress(id, "cancelled", "Анализ остановлен пользователем");
      return;
    }

    persistAnalysisResult(id, "", "running");

    if (shouldUseLocalDebugLLM()) {
      throwIfAborted(controller.signal);
      updateLiveProgress(id, {
        phase: "finalizing",
        phaseLabel: "Локальный debug-режим",
        llmStatus: "Собираем результат без внешнего LLM",
        activeStepId: data.analysisMode === "integrated" ? "integrated_synthesis" : "decision_pack",
      });
      const runtimeStats = buildRuntimeStats(id);
      const result = data.analysisMode === "integrated"
        ? runLocalDebugIntegratedAnalysis(data, runtimeStats)
        : data.analysisMode === "complexity"
          ? runLocalDebugComplexityAnalysis(data, runtimeStats)
          : {
              ...runLocalDebugAnalysis(data),
              runtimeStats,
            };
      throwIfAborted(controller.signal);
      persistAnalysisResult(id, JSON.stringify(result), "done");
      completeAllAnalysisSteps(id);
      finalizeLiveProgress(id, "done");
      return;
    }

    const hintedPlayers = parsePlayersInput(data.players);
    const llmConfig = getActiveLlmConfig();
    if (!llmConfig.baseURL || !llmConfig.apiKey) {
      throw new Error(
        llmConfig.provider === "yandex"
          ? "Yandex AI Studio не настроен: добавьте API-ключ в настройках или YANDEX_AI_STUDIO_API_KEY в .env"
          : "Локальная LLM не настроена: проверьте base URL и API key для LM Studio"
      );
    }

    const client = createOpenAIClient(llmConfig);
    analysisRuntimeConfigs.set(id, llmConfig);
    const model = await resolveConfiguredModel(llmConfig, controller.signal);
    activeModel = model;
    analysisRuntimeModels.set(id, model);
    throwIfAborted(controller.signal);
    completeAnalysisStep(id, "prepare_request");
    updateLiveProgress(id, {
      phase: "queued",
      phaseLabel: "Подключение к LLM",
      llmStatus: `Используем модель: ${model}`,
    });
    console.info(`[llm] analysis ${id} using ${llmConfig.provider} model "${model}" via ${llmConfig.baseURL}`);

    if (data.analysisMode === "integrated") {
      await runIntegratedAnalysis(id, data, client, model, hintedPlayers, controller.signal);
      return;
    }

    if (data.analysisMode === "complexity") {
      await runComplexityAnalysis(id, data, client, model, controller.signal);
      return;
    }

    activateAnalysisStep(id, "setup_players", {
      phase: "setup",
      phaseLabel: "Выделение игроков и границ игры",
      llmStatus: "Определяем ключевых игроков, стимулы и границы игры",
    });
    const strategicSetup = await inferStrategicSetup(client, id, model, data, hintedPlayers, controller.signal);
    completeAnalysisStep(id, "setup_players");
    throwIfAborted(controller.signal);

    activateAnalysisStep(id, "build_profiles", {
      phase: "setup",
      phaseLabel: "Генерация стратегий, допущений и профилей",
      llmStatus: "Строим дерево стратегических профилей",
    });
    const baseProfiles = buildStrategyProfiles(strategicSetup.players);
    completeAnalysisStep(id, "build_profiles");
    activateAnalysisStep(id, "score_profiles", {
      phase: "payoff",
      phaseLabel: "Оценка стратегических профилей",
      llmStatus: `Подготовили ${baseProfiles.length} профилей для оценки`,
      profileCount: baseProfiles.length,
      profileProcessedCount: 0,
    });
    updateLiveProgress(id, {
      phase: "payoff",
      phaseLabel: "Оценка стратегических профилей",
      llmStatus: `Подготовили ${baseProfiles.length} профилей для оценки`,
      profileCount: baseProfiles.length,
      profileProcessedCount: 0,
    });
    const payoffAssessment = await assessProfiles(
      client,
      id,
      model,
      data,
      strategicSetup.players,
      strategicSetup.assumptions,
      strategicSetup.caseFrame,
      strategicSetup.aggregatedActors,
      baseProfiles,
      controller.signal
    );
    completeAnalysisStep(id, "score_profiles");
    throwIfAborted(controller.signal);

    activateAnalysisStep(id, "compute_equilibrium", {
      phase: "finalizing",
      phaseLabel: "Формирование итогового результата",
      llmStatus: "Ищем равновесия Нэша и собираем дашборд",
    });

    const confidence = clamp(
      payoffAssessment.confidence +
        Math.min(strategicSetup.players.length, 5) +
        (strategicSetup.aggregatedActors.length > 0 ? 3 : 0),
      20,
      95
    );

    const gameAnalysis = analyzeProfiles(
      strategicSetup.players,
      payoffAssessment.profiles,
      confidence
    );
    completeAnalysisStep(id, "compute_equilibrium");

    activateAnalysisStep(id, "agent_article", {
      phase: "finalizing",
      phaseLabel: "Развёрнутый анализ агента",
      llmStatus: "Генерируем объяснительную статью по механике игры",
    });
    const agentArticle = await generateAgentArticle(
      client,
      id,
      model,
      data,
      strategicSetup.players,
      strategicSetup.assumptions,
      strategicSetup.aggregatedActors,
      gameAnalysis,
      {
        profiles: payoffAssessment.profiles,
        confidence,
        gameType: payoffAssessment.gameType,
        keyInsights: payoffAssessment.keyInsights,
        breakEquilibriumMoves: payoffAssessment.breakEquilibriumMoves,
        recommendations: payoffAssessment.recommendations,
        sensitivityChecks: payoffAssessment.sensitivityChecks,
      },
      controller.signal
    );
    completeAnalysisStep(id, "agent_article");
    throwIfAborted(controller.signal);

    activateAnalysisStep(id, "decision_pack", {
      phase: "finalizing",
      phaseLabel: "Пакет решения для менеджера продукта",
      llmStatus: "Собираем стратегические ходы, проверки и ограничители запуска",
    });
    const decisionPack = await generateDecisionPack(
      client,
      id,
      model,
      data,
      strategicSetup.players,
      strategicSetup.assumptions,
      strategicSetup.aggregatedActors,
      gameAnalysis,
      {
        confidence,
        gameType: payoffAssessment.gameType,
        keyInsights: payoffAssessment.keyInsights,
        breakEquilibriumMoves: payoffAssessment.breakEquilibriumMoves,
        recommendations: payoffAssessment.recommendations,
        sensitivityChecks: payoffAssessment.sensitivityChecks,
      },
      controller.signal
    );
    completeAnalysisStep(id, "decision_pack");
    throwIfAborted(controller.signal);

    const pairwiseViews = buildPairwiseViews(
      strategicSetup.players,
      payoffAssessment.profiles,
      gameAnalysis.equilibria,
      gameAnalysis.recommendedEquilibrium
    );
    const primaryPairwise = pairwiseViews[0];

    const result: AnalysisResult = {
      analysisMode: "nash",
      playersUsed: strategicSetup.players,
      aggregatedActors: strategicSetup.aggregatedActors,
      assumptions: uniqueStrings([
        ...strategicSetup.assumptions,
        strategicSetup.caseFrame ? `Фрейм игры: ${strategicSetup.caseFrame}` : "",
      ]),
      profiles: payoffAssessment.profiles,
      confidence,
      pairwiseViews,
      sensitivityChecks: payoffAssessment.sensitivityChecks,
      equilibria: gameAnalysis.equilibria,
      recommendedEquilibrium: gameAnalysis.recommendedEquilibrium,
      nashScore: gameAnalysis.nashScore,
      riskLevel: gameAnalysis.riskLevel,
      verdict: gameAnalysis.verdict,
      gameType: payoffAssessment.gameType,
      keyInsights: payoffAssessment.keyInsights,
      breakEquilibriumMoves: payoffAssessment.breakEquilibriumMoves,
      recommendations: payoffAssessment.recommendations,
      decisionPack,
      runtimeStats: buildRuntimeStats(id),
      payoffMatrix: primaryPairwise?.matrix || [],
      matrixPlayers: primaryPairwise ? [...primaryPairwise.players] : [],
      matrixStrategies: primaryPairwise?.matrixStrategies || {},
      rawThinking: agentArticle,
    };

    persistAnalysisResult(id, JSON.stringify(result), "done");
    finalizeLiveProgress(id, "done");
  } catch (err: unknown) {
    if (err instanceof AnalysisCancelledError || isAbortLikeError(err) || storage.getAnalysis(id)?.status === "cancelled") {
      if (storage.getAnalysis(id)?.status !== "cancelled") {
        cancelAnalysisExecution(id);
      } else {
        finalizeLiveProgress(id, "cancelled", "Анализ остановлен пользователем");
      }
      return;
    }

    console.error("Analysis error:", err);
    const errorMessage = getAnalysisErrorMessage(
      err,
      analysisRuntimeModels.get(id) || activeModel,
      analysisRuntimeConfigs.get(id)
    );
    persistAnalysisResult(
      id,
      JSON.stringify({ error: errorMessage }),
      "error"
    );
    finalizeLiveProgress(id, "error", errorMessage);
  } finally {
    analysisRuntimeModels.delete(id);
    analysisRuntimeConfigs.delete(id);
    activeAnalysisControllers.delete(id);
  }
}
