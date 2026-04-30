import {
  type ComplexityAdaptationRule,
  type ComplexityAgent,
  type ComplexityAgentType,
  type ComplexityAnalysisResult,
  type ComplexityCondition,
  type ComplexityFeedbackLoop,
  type ComplexityIntervention,
  type ComplexityPathDependency,
  type ComplexityRegime,
  type ComplexityRegimeKind,
  type ComplexityScenarioDefinition,
  type ComplexityScenarioId,
  type ComplexityScenarioRun,
  type ComplexitySimulationStep,
  type ComplexityStateVariable,
  type ComplexityTippingPoint,
  type ProductDecision,
} from "@shared/schema";

export const COMPLEXITY_CONCEPT_BLOCK = `Complexity Economics — это подход, в котором экономика, рынок и продуктовая среда рассматриваются не как система, стремящаяся к равновесию, а как постоянно меняющаяся адаптивная среда. Игроки действуют с неполной информацией, учатся, копируют удачные ходы, меняют правила поведения и тем самым меняют саму среду. Нас интересуют не статические устойчивые состояния, а динамика адаптации, усиливающие и сдерживающие обратные связи, зависимость от ранних событий, захват траектории развития, пороговые переломы и смена режимов системы во времени.

Пиши весь ответ строго на русском языке.
Не используй англицизмы, если для них есть естественный русский эквивалент.
Не используй английские термины в текстовых значениях, описаниях и пояснениях.
JSON-ключи оставляй строго как в схеме, даже если они написаны на английском.
Вместо английских терминов используй русские:
- feedback loops → обратные связи
- reinforcing loop → усиливающая обратная связь
- balancing loop → сдерживающая обратная связь
- path dependence → зависимость от ранних событий
- lock-in → захват траектории
- tipping point → пороговый перелом
- regime shift → смена режима
- baseline scenario → базовый сценарий
- upside scenario → сценарий ускоренного роста
- stress scenario → стресс-сценарий
- resilience → устойчивость к сбоям
- adaptation capacity → способность к адаптации
- cascade risk → риск каскадного сбоя
- optionality → пространство будущих манёвров

Если в черновике ответа появляются английские слова или англоязычные термины, замени их на естественные русские формулировки перед финальной выдачей.
Не скатывайся в логику равновесия Нэша, матрицы выигрышей, доминирующих стратегий или статического оптимума.`;

export const COMPLEXITY_SETUP_SYSTEM_PROMPT = `Ты — аналитик продуктовых стратегий в логике Complexity Economics.

${COMPLEXITY_CONCEPT_BLOCK}

Твоя задача: по описанию продуктовой стратегии или фичи собрать bounded adaptive simulation.
Не ищи равновесие. Не считай мир статичным. Считай, что игроки адаптируются, а их действия меняют систему.

Верни строго JSON.

Правила:
- Выдели 3–6 ключевых адаптивных игроков.
- Выдели 5–8 переменных состояния системы.
- Опиши 2–4 обратные связи: усиливающие и сдерживающие.
- Для каждого игрока задай 2–4 правила адаптации.
- Добавь 3 сценария: baseline, upside, stress.
- Переменные состояния нормализуй в шкале 0..100.
- Воздействия правил задавай как delta по переменным состояния в диапазоне -15..15.
- Формулируй правила так, чтобы сервер мог прогонять их пошагово.
- Не используй равновесие, матрицу выигрышей и доминирующие стратегии как основу модели.

Формат ответа:
{
  "title": "string",
  "agentsUsed": [
    {
      "id": "a1",
      "name": "string",
      "type": "team|user|competitor|partner|platform|regulator|other",
      "weight": 1,
      "goals": ["string"],
      "likelyMoves": ["string"],
      "adaptationRules": [
        {
          "id": "r1",
          "label": "string",
          "priority": 1,
          "when": [{"variableId": "v1", "op": "lt|lte|gt|gte|between", "value": 50}],
          "move": "string",
          "impacts": {"v1": 5},
          "rationale": "string"
        }
      ]
    }
  ],
  "assumptions": ["string"],
  "stateVariables": [
    {
      "id": "v1",
      "name": "string",
      "description": "string",
      "initialValue": 50,
      "targetDirection": "up|down|range",
      "targetMin": 40,
      "targetMax": 70
    }
  ],
  "feedbackLoops": [
    {
      "id": "loop_1",
      "type": "reinforcing|balancing",
      "label": "string",
      "description": "string",
      "impacts": {"v1": 2}
    }
  ],
  "tippingPoints": [
    {
      "id": "tip_1",
      "label": "string",
      "variableId": "v1",
      "threshold": 70,
      "direction": "up|down",
      "consequence": "string"
    }
  ],
  "pathDependencies": [
    {
      "id": "path_1",
      "earlyCondition": "string",
      "laterEffect": "string",
      "reversibility": "easy|moderate|hard"
    }
  ],
  "interventions": [
    {
      "id": "i1",
      "timing": "prelaunch|launch|postlaunch",
      "label": "string",
      "description": "string",
      "intendedImpacts": {"v1": 5},
      "tradeoffs": ["string"]
    }
  ],
  "scenarios": [
    {"id": "baseline", "label": "Базовый сценарий", "description": "string", "shocks": {"v1": 0}},
    {"id": "upside", "label": "Сценарий ускоренного роста", "description": "string", "shocks": {"v1": 4}},
    {"id": "stress", "label": "Стресс-сценарий", "description": "string", "shocks": {"v1": -4}}
  ]
}`;

export const COMPLEXITY_ARTICLE_SYSTEM_PROMPT = `Ты — аналитик, который объясняет менеджеру продукта результат в логике Complexity Economics.

${COMPLEXITY_CONCEPT_BLOCK}

На входе:
- описание кейса
- контекст
- адаптивные игроки
- переменные состояния
- обратные связи
- сценарии и шаги симуляции
- выявленные режимы, пороговые переломы и зависимости от ранних событий

Напиши развёрнутый анализ на русском языке.
Фокус:
- как система меняется во времени;
- где есть нелинейность;
- что усиливает рост;
- что запускает деградацию;
- какие ранние сигналы важнее всего;
- какие вмешательства реально меняют траекторию.

Верни строго JSON:
{
  "rawThinking": "string"
}`;

export const COMPLEXITY_DECISION_SYSTEM_PROMPT = `Ты — помощник менеджера продукта для принятия решений в логике Complexity Economics.

${COMPLEXITY_CONCEPT_BLOCK}

На входе:
- исходный кейс
- сценарии ограниченной адаптивной симуляции
- финальные состояния
- режимы системы
- пороговые переломы
- зависимости от ранних событий
- возможные вмешательства

Твоя задача:
- дать управленческий вердикт;
- не рассуждать через устойчивое равновесие;
- оценить устойчивость к сбоям, способность к адаптации, риск захвата траектории, риск каскадного сбоя и пространство будущих манёвров;
- выделить ранние сигналы и триггеры смены режима;
- дать практические рекомендации для пилота или запуска.

Верни строго JSON:
{
  "executiveSummary": "string",
  "resilienceScore": 0,
  "adaptationCapacity": 0,
  "lockInRisk": 0,
  "cascadeRisk": 0,
  "optionalityScore": 0,
  "confidence": 0,
  "verdict": "launch|revise|pause|kill",
  "verdictLabel": "string",
  "dominantRegimes": [
    {"id": "regime_1", "label": "string", "kind": "growth|stall|lock_in|cascade|overload|commoditization|recovery", "severity": "low|medium|high", "evidence": ["string"]}
  ],
  "earlySignals": ["string"],
  "regimeShiftTriggers": ["string"],
  "keyInsights": ["string"],
  "recommendations": ["string"]
}`;

export interface ComplexitySetupResponse {
  title?: string;
  agentsUsed?: unknown;
  assumptions?: unknown;
  stateVariables?: unknown;
  feedbackLoops?: unknown;
  tippingPoints?: unknown;
  pathDependencies?: unknown;
  interventions?: unknown;
  scenarios?: unknown;
}

export interface ComplexityDecisionResponse {
  executiveSummary?: string;
  resilienceScore?: number;
  adaptationCapacity?: number;
  lockInRisk?: number;
  cascadeRisk?: number;
  optionalityScore?: number;
  confidence?: number;
  verdict?: string;
  verdictLabel?: string;
  dominantRegimes?: unknown;
  earlySignals?: unknown;
  regimeShiftTriggers?: unknown;
  keyInsights?: unknown;
  recommendations?: unknown;
}

export interface ComplexityArticleResponse {
  rawThinking?: string;
}

export interface NormalizedComplexitySetup {
  title: string;
  agentsUsed: ComplexityAgent[];
  assumptions: string[];
  stateVariables: ComplexityStateVariable[];
  feedbackLoops: ComplexityFeedbackLoop[];
  tippingPoints: ComplexityTippingPoint[];
  pathDependencies: ComplexityPathDependency[];
  interventions: ComplexityIntervention[];
  scenarioDefinitions: ComplexityScenarioDefinition[];
}

export interface ComplexitySimulationPackage {
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
  executiveSummary: string;
}

const SCENARIO_IDS: ComplexityScenarioId[] = ["baseline", "upside", "stress"];
const COMPLEXITY_STEP_COUNT = 8;

export function clampComplexity(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeTextList(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const text = normalizeText(item);
    if (text && !seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }

  return result.length ? result : fallback;
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return clampComplexity(Math.round(number), min, max);
}

function normalizeRecord(value: unknown, variableIds: Set<string>, min = -15, max = 15): Record<string, number> {
  const raw = asObject(value);
  const result: Record<string, number> = {};

  for (const [key, item] of Object.entries(raw)) {
    if (!variableIds.has(key)) {
      continue;
    }
    result[key] = normalizeNumber(item, 0, min, max);
  }

  return result;
}

function normalizeAgentType(value: unknown): ComplexityAgentType {
  switch (value) {
    case "team":
    case "user":
    case "competitor":
    case "partner":
    case "platform":
    case "regulator":
    case "other":
      return value;
    default:
      return "other";
  }
}

function normalizeScenarioId(value: unknown, index: number): ComplexityScenarioId {
  if (value === "baseline" || value === "upside" || value === "stress") {
    return value;
  }
  return SCENARIO_IDS[index] || "baseline";
}

function normalizeCondition(raw: unknown, variableIds: Set<string>): ComplexityCondition | null {
  const item = asObject(raw);
  const variableId = normalizeText(item.variableId);
  if (!variableIds.has(variableId)) {
    return null;
  }

  const op = item.op;
  const normalizedOp: ComplexityCondition["op"] =
    op === "lt" || op === "lte" || op === "gt" || op === "gte" || op === "between" ? op : "gt";

  if (normalizedOp === "between") {
    const rawValue = Array.isArray(item.value) ? item.value : [35, 65];
    return {
      variableId,
      op: normalizedOp,
      value: [
        normalizeNumber(rawValue[0], 35, 0, 100),
        normalizeNumber(rawValue[1], 65, 0, 100),
      ],
    };
  }

  return {
    variableId,
    op: normalizedOp,
    value: normalizeNumber(item.value, 50, 0, 100),
  };
}

function normalizeRule(
  raw: unknown,
  variableIds: Set<string>,
  index: number,
): ComplexityAdaptationRule | null {
  const item = asObject(raw);
  const impacts = normalizeRecord(item.impacts, variableIds);
  if (Object.keys(impacts).length === 0) {
    return null;
  }

  const when = Array.isArray(item.when)
    ? item.when
        .map((condition) => normalizeCondition(condition, variableIds))
        .filter((condition): condition is ComplexityCondition => Boolean(condition))
    : [];

  return {
    id: normalizeText(item.id, `rule_${index + 1}`),
    label: normalizeText(item.label, `Правило ${index + 1}`),
    priority: normalizeNumber(item.priority, index + 1, 1, 99),
    when,
    move: normalizeText(item.move, "Адаптировать поведение"),
    impacts,
    rationale: normalizeText(item.rationale, "Игрок меняет поведение из-за изменения состояния системы."),
  };
}

function normalizeStateVariables(value: unknown): ComplexityStateVariable[] {
  const source = Array.isArray(value) ? value : [];
  const variables = source
    .map((raw, index) => {
      const item = asObject(raw);
      const id = normalizeText(item.id, `v${index + 1}`).replace(/\s+/g, "_");
      const targetDirection = item.targetDirection === "down" || item.targetDirection === "range" ? item.targetDirection : "up";
      return {
        id,
        name: normalizeText(item.name, `Переменная ${index + 1}`),
        description: normalizeText(item.description, "Состояние системы, влияющее на траекторию запуска."),
        initialValue: normalizeNumber(item.initialValue, 50, 0, 100),
        targetDirection,
        targetMin: targetDirection === "range" ? normalizeNumber(item.targetMin, 35, 0, 100) : undefined,
        targetMax: targetDirection === "range" ? normalizeNumber(item.targetMax, 70, 0, 100) : undefined,
      } satisfies ComplexityStateVariable;
    })
    .filter((item) => item.id && item.name)
    .slice(0, 8);

  if (variables.length >= 3) {
    return variables;
  }

  return [
    {
      id: "adoption",
      name: "Принятие пользователями",
      description: "Насколько быстро целевая аудитория начинает пользоваться решением.",
      initialValue: 45,
      targetDirection: "up",
    },
    {
      id: "trust",
      name: "Доверие к механике",
      description: "Насколько участники верят, что новая механика работает предсказуемо.",
      initialValue: 55,
      targetDirection: "up",
    },
    {
      id: "load",
      name: "Операционная нагрузка",
      description: "Нагрузка на поддержку, операции и соседние команды.",
      initialValue: 35,
      targetDirection: "down",
    },
    {
      id: "fraud_pressure",
      name: "Давление злоупотреблений",
      description: "Вероятность атак на экономику или правила механики.",
      initialValue: 25,
      targetDirection: "down",
    },
    {
      id: "unit_economics",
      name: "Юнит-экономика",
      description: "Насколько экономически устойчива траектория запуска.",
      initialValue: 50,
      targetDirection: "up",
    },
  ];
}

function normalizeAgents(value: unknown, variableIds: Set<string>): ComplexityAgent[] {
  const source = Array.isArray(value) ? value : [];
  const agents = source
    .map((raw, index) => {
      const item = asObject(raw);
      const rules = Array.isArray(item.adaptationRules)
        ? item.adaptationRules
            .map((rule, ruleIndex) => normalizeRule(rule, variableIds, ruleIndex))
            .filter((rule): rule is ComplexityAdaptationRule => Boolean(rule))
            .slice(0, 4)
        : [];

      return {
        id: normalizeText(item.id, `a${index + 1}`).replace(/\s+/g, "_"),
        name: normalizeText(item.name, `Игрок ${index + 1}`),
        type: normalizeAgentType(item.type),
        weight: normalizeNumber(item.weight, 3, 1, 5),
        goals: normalizeTextList(item.goals, ["Сохранить выгоду и снизить неопределённость"]).slice(0, 4),
        likelyMoves: normalizeTextList(item.likelyMoves, ["Адаптировать поведение после первых сигналов"]).slice(0, 4),
        adaptationRules: rules,
      } satisfies ComplexityAgent;
    })
    .filter((agent) => agent.name && agent.adaptationRules.length > 0)
    .slice(0, 6);

  return agents.length >= 2 ? agents : [];
}

function normalizeFeedbackLoops(value: unknown, variableIds: Set<string>): ComplexityFeedbackLoop[] {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((raw, index) => {
      const item = asObject(raw);
      return {
        id: normalizeText(item.id, `loop_${index + 1}`),
        type: item.type === "balancing" ? "balancing" : "reinforcing",
        label: normalizeText(item.label, `Обратная связь ${index + 1}`),
        description: normalizeText(item.description, "Связь между состояниями системы."),
        impacts: normalizeRecord(item.impacts, variableIds, -4, 4),
      } satisfies ComplexityFeedbackLoop;
    })
    .filter((loop) => loop.label)
    .slice(0, 4);
}

function normalizeTippingPoints(value: unknown, variableIds: Set<string>): ComplexityTippingPoint[] {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((raw, index) => {
      const item = asObject(raw);
      const variableId = normalizeText(item.variableId);
      if (!variableIds.has(variableId)) {
        return null;
      }
      return {
        id: normalizeText(item.id, `tip_${index + 1}`),
        label: normalizeText(item.label, `Пороговый перелом ${index + 1}`),
        variableId,
        threshold: normalizeNumber(item.threshold, 65, 0, 100),
        direction: item.direction === "down" ? "down" : "up",
        consequence: normalizeText(item.consequence, "После пересечения порога система меняет режим."),
      } satisfies ComplexityTippingPoint;
    })
    .filter((item): item is ComplexityTippingPoint => Boolean(item))
    .slice(0, 6);
}

function normalizePathDependencies(value: unknown): ComplexityPathDependency[] {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((raw, index) => {
      const item = asObject(raw);
      const reversibility = item.reversibility === "easy" || item.reversibility === "hard" ? item.reversibility : "moderate";
      return {
        id: normalizeText(item.id, `path_${index + 1}`),
        earlyCondition: normalizeText(item.earlyCondition, "Ранний сигнал закрепляет дальнейшую траекторию."),
        laterEffect: normalizeText(item.laterEffect, "Позже системе сложнее изменить направление."),
        reversibility,
      } satisfies ComplexityPathDependency;
    })
    .filter((item) => item.earlyCondition && item.laterEffect)
    .slice(0, 6);
}

function normalizeInterventions(value: unknown, variableIds: Set<string>): ComplexityIntervention[] {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((raw, index) => {
      const item = asObject(raw);
      const timing = item.timing === "prelaunch" || item.timing === "postlaunch" ? item.timing : "launch";
      return {
        id: normalizeText(item.id, `i${index + 1}`),
        timing,
        label: normalizeText(item.label, `Вмешательство ${index + 1}`),
        description: normalizeText(item.description, "Управленческое действие, меняющее траекторию системы."),
        intendedImpacts: normalizeRecord(item.intendedImpacts, variableIds),
        tradeoffs: normalizeTextList(item.tradeoffs, ["Потребует управленческого внимания"]).slice(0, 4),
      } satisfies ComplexityIntervention;
    })
    .filter((item) => item.label)
    .slice(0, 6);
}

function normalizeScenarios(value: unknown, variableIds: Set<string>): ComplexityScenarioDefinition[] {
  const source = Array.isArray(value) ? value : [];
  const byId = new Map<ComplexityScenarioId, ComplexityScenarioDefinition>();

  source.forEach((raw, index) => {
    const item = asObject(raw);
    const id = normalizeScenarioId(item.id, index);
    byId.set(id, {
      id,
      label: normalizeText(item.label, getDefaultScenarioLabel(id)),
      description: normalizeText(item.description, getDefaultScenarioDescription(id)),
      shocks: normalizeRecord(item.shocks, variableIds, -10, 10),
    });
  });

  return SCENARIO_IDS.map((id) => byId.get(id) || {
    id,
    label: getDefaultScenarioLabel(id),
    description: getDefaultScenarioDescription(id),
    shocks: getDefaultScenarioShocks(id, variableIds),
  });
}

function getDefaultScenarioLabel(id: ComplexityScenarioId): string {
  switch (id) {
    case "upside":
      return "Сценарий ускоренного роста";
    case "stress":
      return "Стресс-сценарий";
    default:
      return "Базовый сценарий";
  }
}

function getDefaultScenarioDescription(id: ComplexityScenarioId): string {
  switch (id) {
    case "upside":
      return "Ранние сигналы складываются в пользу запуска, участники быстрее адаптируются к новой механике.";
    case "stress":
      return "Система сталкивается с сопротивлением, перегрузкой или ухудшением доверия.";
    default:
      return "Система развивается без сильного внешнего ускорения или шока.";
  }
}

function getDefaultScenarioShocks(id: ComplexityScenarioId, variableIds: Set<string>): Record<string, number> {
  const result: Record<string, number> = {};
  Array.from(variableIds).forEach((variableId) => {
    if (/load|fraud|risk|pressure|cost|costs/i.test(variableId)) {
      result[variableId] = id === "stress" ? 4 : id === "upside" ? -2 : 0;
    } else {
      result[variableId] = id === "stress" ? -3 : id === "upside" ? 3 : 0;
    }
  });
  return result;
}

export function normalizeComplexitySetup(
  raw: ComplexitySetupResponse,
  fallbackTitle: string,
): NormalizedComplexitySetup {
  const stateVariables = normalizeStateVariables(raw.stateVariables);
  const variableIds = new Set(stateVariables.map((variable) => variable.id));
  const agentsUsed = normalizeAgents(raw.agentsUsed, variableIds);

  if (agentsUsed.length < 2) {
    throw new Error("LLM не вернула достаточный набор адаптивных игроков для Complexity-анализа");
  }

  return {
    title: normalizeText(raw.title, fallbackTitle),
    agentsUsed,
    assumptions: normalizeTextList(raw.assumptions, ["Система моделируется как ограниченная адаптивная симуляция на раннем горизонте запуска."]).slice(0, 8),
    stateVariables,
    feedbackLoops: normalizeFeedbackLoops(raw.feedbackLoops, variableIds),
    tippingPoints: normalizeTippingPoints(raw.tippingPoints, variableIds),
    pathDependencies: normalizePathDependencies(raw.pathDependencies),
    interventions: normalizeInterventions(raw.interventions, variableIds),
    scenarioDefinitions: normalizeScenarios(raw.scenarios, variableIds),
  };
}

function conditionMatches(condition: ComplexityCondition, state: Record<string, number>): boolean {
  const value = state[condition.variableId] ?? 0;
  switch (condition.op) {
    case "lt":
      return value < (condition.value as number);
    case "lte":
      return value <= (condition.value as number);
    case "gt":
      return value > (condition.value as number);
    case "gte":
      return value >= (condition.value as number);
    case "between": {
      const [min, max] = Array.isArray(condition.value) ? condition.value : [0, 100];
      return value >= min && value <= max;
    }
    default:
      return false;
  }
}

function ruleMatches(rule: ComplexityAdaptationRule, state: Record<string, number>): boolean {
  return rule.when.length === 0 || rule.when.every((condition) => conditionMatches(condition, state));
}

function mergeDelta(target: Record<string, number>, source: Record<string, number>, factor = 1) {
  for (const [variableId, value] of Object.entries(source)) {
    target[variableId] = (target[variableId] || 0) + value * factor;
  }
}

function evaluateStateVariable(variable: ComplexityStateVariable, value: number): number {
  if (variable.targetDirection === "down") {
    return 100 - value;
  }

  if (variable.targetDirection === "range") {
    const min = variable.targetMin ?? 35;
    const max = variable.targetMax ?? 70;
    if (value >= min && value <= max) {
      return 100;
    }
    return value < min ? clampComplexity(100 - (min - value) * 2, 0, 100) : clampComplexity(100 - (value - max) * 2, 0, 100);
  }

  return value;
}

function scenarioHealth(state: Record<string, number>, variables: ComplexityStateVariable[]): number {
  if (variables.length === 0) {
    return 50;
  }

  return Math.round(
    variables.reduce((sum, variable) => sum + evaluateStateVariable(variable, state[variable.id] ?? variable.initialValue), 0) /
      variables.length
  );
}

function detectStepSignals(
  state: Record<string, number>,
  tippingPoints: ComplexityTippingPoint[],
): string[] {
  return tippingPoints
    .filter((point) => {
      const value = state[point.variableId] ?? 0;
      return point.direction === "down" ? value <= point.threshold : value >= point.threshold;
    })
    .map((point) => `${point.label}: ${point.consequence}`);
}

function inferRegimeForScenario(
  scenario: ComplexityScenarioRun,
  variables: ComplexityStateVariable[],
  pathDependencies: ComplexityPathDependency[],
): ComplexityRegime {
  const finalHealth = scenarioHealth(scenario.finalState, variables);
  const signals = scenario.steps.flatMap((step) => step.regimeSignals);
  const overloadVariable = variables.find((variable) => /нагруз|load|support|операц/i.test(`${variable.id} ${variable.name}`));
  const fraudVariable = variables.find((variable) => /фрод|злоуп|fraud|abuse/i.test(`${variable.id} ${variable.name}`));
  const adoptionVariable = variables.find((variable) => /принят|adoption|спрос|рост|demand/i.test(`${variable.id} ${variable.name}`));
  const overload = overloadVariable ? scenario.finalState[overloadVariable.id] ?? 0 : 0;
  const fraud = fraudVariable ? scenario.finalState[fraudVariable.id] ?? 0 : 0;
  const adoption = adoptionVariable ? scenario.finalState[adoptionVariable.id] ?? finalHealth : finalHealth;

  let kind: ComplexityRegimeKind = "stall";
  if (finalHealth >= 72 && adoption >= 60) {
    kind = "growth";
  } else if (overload >= 70) {
    kind = "overload";
  } else if (fraud >= 68 || signals.length >= 3) {
    kind = "cascade";
  } else if (pathDependencies.some((item) => item.reversibility === "hard") && adoption >= 65) {
    kind = "lock_in";
  } else if (finalHealth >= 55) {
    kind = "recovery";
  }

  const severity: ComplexityRegime["severity"] =
    kind === "growth" || kind === "recovery"
      ? finalHealth >= 72 ? "low" : "medium"
      : finalHealth < 42 || signals.length >= 3 ? "high" : "medium";

  return {
    id: `regime_${scenario.id}`,
    label: getRegimeLabel(kind),
    kind,
    severity,
    evidence: [
      `Финальное здоровье сценария: ${finalHealth}`,
      signals[0] || "Пороговые переломы не доминируют в этом сценарии.",
      scenario.outcomeSummary,
    ],
  };
}

function getRegimeLabel(kind: ComplexityRegimeKind): string {
  switch (kind) {
    case "growth":
      return "Режим самоподдерживающегося роста";
    case "lock_in":
      return "Режим захвата траектории";
    case "cascade":
      return "Режим каскадного сбоя";
    case "overload":
      return "Режим операционной перегрузки";
    case "commoditization":
      return "Режим обесценивания отличий";
    case "recovery":
      return "Режим управляемого восстановления";
    default:
      return "Режим застревания";
  }
}

function summarizeScenario(scenario: ComplexityScenarioRun, variables: ComplexityStateVariable[]): string {
  const health = scenarioHealth(scenario.finalState, variables);
  if (health >= 75) {
    return "Система выходит на сильную траекторию: рост поддерживается без резкой деградации ключевых переменных.";
  }
  if (health >= 55) {
    return "Система остаётся управляемой, но требует ранних вмешательств и наблюдения за пороговыми сигналами.";
  }
  return "Система уходит в хрупкую траекторию: ранние напряжения усиливаются и могут закрепиться.";
}

export function simulateComplexitySystem(setup: NormalizedComplexitySetup): ComplexitySimulationPackage {
  const scenarioRuns: ComplexityScenarioRun[] = setup.scenarioDefinitions.map((scenarioDefinition) => {
    const state: Record<string, number> = Object.fromEntries(
      setup.stateVariables.map((variable) => [variable.id, variable.initialValue])
    );
    const steps: ComplexitySimulationStep[] = [];

    for (let step = 1; step <= COMPLEXITY_STEP_COUNT; step += 1) {
      const delta: Record<string, number> = {};
      const triggeredRules: ComplexitySimulationStep["triggeredRules"] = [];
      const events: string[] = [];

      mergeDelta(delta, scenarioDefinition.shocks || {}, step <= 2 ? 1 : 0.35);

      for (const loop of setup.feedbackLoops) {
        if (loop.impacts && Object.keys(loop.impacts).length > 0) {
          mergeDelta(delta, loop.impacts, loop.type === "reinforcing" ? 0.45 : 0.28);
        }
      }

      for (const agent of setup.agentsUsed) {
        const rule = agent.adaptationRules
          .slice()
          .sort((left, right) => left.priority - right.priority)
          .find((candidate) => ruleMatches(candidate, state));

        if (!rule) {
          continue;
        }

        mergeDelta(delta, rule.impacts, 1);
        triggeredRules.push({ agentId: agent.id, ruleId: rule.id, move: rule.move });
        events.push(`${agent.name}: ${rule.move}`);
      }

      const nextState = { ...state };
      for (const variable of setup.stateVariables) {
        nextState[variable.id] = clampComplexity(Math.round((state[variable.id] ?? 0) + (delta[variable.id] || 0)), 0, 100);
      }

      const regimeSignals = detectStepSignals(nextState, setup.tippingPoints);
      steps.push({
        step,
        state: nextState,
        delta: Object.fromEntries(
          Object.entries(delta).map(([key, value]) => [key, Math.round(value)])
        ),
        triggeredRules,
        events,
        regimeSignals,
      });
      Object.assign(state, nextState);
    }

    const run: ComplexityScenarioRun = {
      id: scenarioDefinition.id,
      label: scenarioDefinition.label,
      description: scenarioDefinition.description,
      steps,
      finalState: { ...state },
      dominantRegimeId: null,
      outcomeSummary: "",
    };
    run.outcomeSummary = summarizeScenario(run, setup.stateVariables);
    return run;
  });

  const regimes = scenarioRuns.map((scenario) => inferRegimeForScenario(scenario, setup.stateVariables, setup.pathDependencies));
  const regimesByScenario = new Map(scenarioRuns.map((scenario, index) => [scenario.id, regimes[index]]));
  const scenarios = scenarioRuns.map((scenario) => ({
    ...scenario,
    dominantRegimeId: regimesByScenario.get(scenario.id)?.id || null,
  }));
  const baseline = scenarios.find((scenario) => scenario.id === "baseline") || scenarios[0];
  const stress = scenarios.find((scenario) => scenario.id === "stress") || scenarios[0];
  const upside = scenarios.find((scenario) => scenario.id === "upside") || scenarios[0];
  const baselineHealth = scenarioHealth(baseline.finalState, setup.stateVariables);
  const stressHealth = scenarioHealth(stress.finalState, setup.stateVariables);
  const upsideHealth = scenarioHealth(upside.finalState, setup.stateVariables);
  const allSignals = scenarios.flatMap((scenario) => scenario.steps.flatMap((step) => step.regimeSignals));
  const hardPaths = setup.pathDependencies.filter((item) => item.reversibility === "hard").length;
  const totalRules = setup.agentsUsed.reduce((sum, agent) => sum + agent.adaptationRules.length, 0);
  const triggeredRuleIds = new Set(scenarios.flatMap((scenario) => scenario.steps.flatMap((step) => step.triggeredRules.map((rule) => rule.ruleId))));

  const resilienceScore = clampComplexity(Math.round(stressHealth * 0.65 + baselineHealth * 0.35 - allSignals.length * 2), 0, 100);
  const adaptationCapacity = clampComplexity(
    Math.round((triggeredRuleIds.size / Math.max(totalRules, 1)) * 55 + setup.interventions.length * 7 + baselineHealth * 0.25),
    0,
    100,
  );
  const lockInRisk = clampComplexity(
    Math.round(hardPaths * 16 + Math.max(0, upsideHealth - baselineHealth) * 0.35 + regimes.filter((item) => item.kind === "lock_in").length * 18),
    0,
    100,
  );
  const cascadeRisk = clampComplexity(
    Math.round(allSignals.length * 8 + regimes.filter((item) => item.kind === "cascade" || item.kind === "overload").length * 18 + Math.max(0, 55 - stressHealth) * 0.8),
    0,
    100,
  );
  const optionalityScore = clampComplexity(
    Math.round(70 + setup.interventions.length * 5 - lockInRisk * 0.25 - cascadeRisk * 0.2 - Math.abs(upsideHealth - stressHealth) * 0.15),
    0,
    100,
  );
  const confidence = clampComplexity(
    Math.round(45 + setup.agentsUsed.length * 5 + setup.stateVariables.length * 3 + setup.feedbackLoops.length * 4 + setup.tippingPoints.length * 2),
    35,
    92,
  );
  const verdict = deriveComplexityVerdict(resilienceScore, adaptationCapacity, lockInRisk, cascadeRisk, optionalityScore, confidence);

  const regimeShiftTriggers = Array.from(new Set([
    ...allSignals,
    ...setup.tippingPoints.map((point) => `${point.label}: порог ${point.threshold}`),
  ])).slice(0, 8);
  const earlySignals = Array.from(new Set([
    ...setup.stateVariables.slice(0, 4).map((variable) => `Изменение переменной «${variable.name}» в первые 2–3 шага`),
    ...setup.feedbackLoops.slice(0, 3).map((loop) => `Усиление связи «${loop.label}»`),
  ])).slice(0, 8);
  const keyInsights = [
    `Базовая траектория получает оценку здоровья ${baselineHealth}, стрессовая — ${stressHealth}.`,
    cascadeRisk >= 60
      ? "Главный риск — каскадное усиление ранней проблемы до смены режима системы."
      : "Система выглядит управляемой, если ранние сигналы будут отслеживаться до масштабирования.",
    lockInRisk >= 60
      ? "Есть заметный риск захвата траектории: ранние решения могут закрепить дорогой режим."
      : "Риск необратимого закрепления траектории умеренный, пространство манёвров сохраняется.",
  ];
  const recommendations = [
    "Запускать через ограниченный пилот с заранее заданными порогами вмешательства.",
    "Наблюдать не только итоговые метрики, но и ранние переменные состояния, которые показывают смену режима.",
    "До масштабирования подготовить вмешательства, которые ослабляют каскадные сбои и сохраняют пространство будущих манёвров.",
  ];

  return {
    scenarios,
    dominantRegimes: regimes,
    earlySignals,
    regimeShiftTriggers,
    resilienceScore,
    adaptationCapacity,
    lockInRisk,
    cascadeRisk,
    optionalityScore,
    confidence,
    verdict,
    verdictLabel: getComplexityVerdictLabel(verdict),
    keyInsights,
    recommendations,
    executiveSummary: buildComplexityExecutiveSummary(verdict, resilienceScore, cascadeRisk, lockInRisk),
  };
}

function deriveComplexityVerdict(
  resilienceScore: number,
  adaptationCapacity: number,
  lockInRisk: number,
  cascadeRisk: number,
  optionalityScore: number,
  confidence: number,
): ProductDecision {
  if (resilienceScore >= 72 && adaptationCapacity >= 60 && cascadeRisk < 55 && lockInRisk < 65 && confidence >= 55) {
    return "launch";
  }
  if (resilienceScore >= 52 && optionalityScore >= 45 && cascadeRisk < 75) {
    return "revise";
  }
  if (resilienceScore >= 38 || optionalityScore >= 35) {
    return "pause";
  }
  return "kill";
}

function getComplexityVerdictLabel(verdict: ProductDecision): string {
  switch (verdict) {
    case "launch":
      return "Запускать через управляемый пилот";
    case "revise":
      return "Доработать условия запуска";
    case "pause":
      return "Поставить на паузу до снятия рисков";
    case "kill":
      return "Не запускать в текущей форме";
    default:
      return "Требуется решение";
  }
}

function buildComplexityExecutiveSummary(
  verdict: ProductDecision,
  resilienceScore: number,
  cascadeRisk: number,
  lockInRisk: number,
): string {
  return `${getComplexityVerdictLabel(verdict)}. Устойчивость к сбоям: ${resilienceScore}, риск каскадного сбоя: ${cascadeRisk}, риск захвата траектории: ${lockInRisk}.`;
}

export function normalizeComplexityDecision(
  raw: ComplexityDecisionResponse,
  fallback: ComplexitySimulationPackage,
): Pick<
  ComplexitySimulationPackage,
  | "executiveSummary"
  | "resilienceScore"
  | "adaptationCapacity"
  | "lockInRisk"
  | "cascadeRisk"
  | "optionalityScore"
  | "confidence"
  | "verdict"
  | "verdictLabel"
  | "dominantRegimes"
  | "earlySignals"
  | "regimeShiftTriggers"
  | "keyInsights"
  | "recommendations"
> {
  const verdict = raw.verdict === "launch" || raw.verdict === "revise" || raw.verdict === "pause" || raw.verdict === "kill"
    ? raw.verdict
    : fallback.verdict;

  return {
    executiveSummary: normalizeText(raw.executiveSummary, fallback.executiveSummary),
    resilienceScore: normalizeNumber(raw.resilienceScore, fallback.resilienceScore, 0, 100),
    adaptationCapacity: normalizeNumber(raw.adaptationCapacity, fallback.adaptationCapacity, 0, 100),
    lockInRisk: normalizeNumber(raw.lockInRisk, fallback.lockInRisk, 0, 100),
    cascadeRisk: normalizeNumber(raw.cascadeRisk, fallback.cascadeRisk, 0, 100),
    optionalityScore: normalizeNumber(raw.optionalityScore, fallback.optionalityScore, 0, 100),
    confidence: normalizeNumber(raw.confidence, fallback.confidence, 0, 100),
    verdict,
    verdictLabel: normalizeText(raw.verdictLabel, getComplexityVerdictLabel(verdict)),
    dominantRegimes: normalizeRegimes(raw.dominantRegimes, fallback.dominantRegimes),
    earlySignals: normalizeTextList(raw.earlySignals, fallback.earlySignals).slice(0, 8),
    regimeShiftTriggers: normalizeTextList(raw.regimeShiftTriggers, fallback.regimeShiftTriggers).slice(0, 8),
    keyInsights: normalizeTextList(raw.keyInsights, fallback.keyInsights).slice(0, 8),
    recommendations: normalizeTextList(raw.recommendations, fallback.recommendations).slice(0, 8),
  };
}

function normalizeRegimes(value: unknown, fallback: ComplexityRegime[]): ComplexityRegime[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const regimes = value
    .map((raw, index) => {
      const item = asObject(raw);
      const kind = normalizeRegimeKind(item.kind);
      const severity = item.severity === "low" || item.severity === "high" ? item.severity : "medium";
      return {
        id: normalizeText(item.id, `regime_${index + 1}`),
        label: normalizeText(item.label, getRegimeLabel(kind)),
        kind,
        severity,
        evidence: normalizeTextList(item.evidence, ["Режим определён по траектории сценариев."]).slice(0, 4),
      } satisfies ComplexityRegime;
    })
    .filter((item) => item.label)
    .slice(0, 6);

  return regimes.length ? regimes : fallback;
}

function normalizeRegimeKind(value: unknown): ComplexityRegimeKind {
  switch (value) {
    case "growth":
    case "stall":
    case "lock_in":
    case "cascade":
    case "overload":
    case "commoditization":
    case "recovery":
      return value;
    default:
      return "stall";
  }
}

export function composeComplexityResult(
  title: string,
  setup: NormalizedComplexitySetup,
  simulation: ComplexitySimulationPackage,
  decision: ReturnType<typeof normalizeComplexityDecision>,
  rawThinking: string,
  runtimeStats: ComplexityAnalysisResult["runtimeStats"],
): ComplexityAnalysisResult {
  return {
    analysisMode: "complexity",
    modelKind: "bounded_adaptive_simulation",
    title,
    executiveSummary: decision.executiveSummary,
    agentsUsed: setup.agentsUsed,
    assumptions: setup.assumptions,
    stateVariables: setup.stateVariables,
    feedbackLoops: setup.feedbackLoops,
    tippingPoints: setup.tippingPoints,
    pathDependencies: setup.pathDependencies,
    interventions: setup.interventions,
    scenarios: simulation.scenarios,
    dominantRegimes: decision.dominantRegimes,
    earlySignals: decision.earlySignals,
    regimeShiftTriggers: decision.regimeShiftTriggers,
    resilienceScore: decision.resilienceScore,
    adaptationCapacity: decision.adaptationCapacity,
    lockInRisk: decision.lockInRisk,
    cascadeRisk: decision.cascadeRisk,
    optionalityScore: decision.optionalityScore,
    confidence: decision.confidence,
    verdict: decision.verdict,
    verdictLabel: decision.verdictLabel,
    keyInsights: decision.keyInsights,
    recommendations: decision.recommendations,
    runtimeStats,
    rawThinking,
  };
}

export function assertComplexityGuardrails(value: unknown): void {
  const forbidden = [
    /равновеси[ея]\s+нэша/i,
    /\bNash\b/i,
    /матриц[аы]\s+выигрыш/i,
    /dominant strateg/i,
    /payoff matrix/i,
  ];
  const snippets: string[] = [];

  function walk(item: unknown) {
    if (typeof item === "string") {
      for (const pattern of forbidden) {
        if (pattern.test(item)) {
          snippets.push(item.slice(0, 140));
          break;
        }
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(walk);
      return;
    }
    if (item && typeof item === "object") {
      Object.values(item as Record<string, unknown>).forEach(walk);
    }
  }

  walk(value);
  if (snippets.length > 0) {
    throw new Error(`Complexity-ответ содержит Nash-термины в пользовательском тексте: ${snippets.slice(0, 3).join(" | ")}`);
  }
}
