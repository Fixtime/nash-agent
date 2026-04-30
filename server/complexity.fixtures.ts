import {
  assertComplexityGuardrails,
  composeComplexityResult,
  normalizeComplexityDecision,
  normalizeComplexitySetup,
  simulateComplexitySystem,
  type ComplexityDecisionResponse,
  type ComplexitySetupResponse,
} from "./complexity";

export const complexitySetupFixture: ComplexitySetupResponse = {
  title: "Пилот реферальной программы",
  agentsUsed: [
    {
      id: "a1",
      name: "Команда продукта",
      type: "team",
      weight: 5,
      goals: ["Увеличить органический рост без ухудшения экономики"],
      likelyMoves: ["Запустить ограниченный пилот", "Усилить контроль злоупотреблений"],
      adaptationRules: [
        {
          id: "r1",
          label: "Сужение пилота при росте злоупотреблений",
          priority: 1,
          when: [{ variableId: "abuse_pressure", op: "gt", value: 62 }],
          move: "Сократить аудиторию пилота и добавить проверку качества приглашений",
          impacts: { abuse_pressure: -8, adoption: -3, trust: 4 },
          rationale: "Команда снижает скорость роста ради сохранения доверия и экономики.",
        },
        {
          id: "r2",
          label: "Масштабирование при здоровой тяге",
          priority: 2,
          when: [{ variableId: "adoption", op: "gt", value: 58 }],
          move: "Расширить пилот на следующий сегмент пользователей",
          impacts: { adoption: 7, support_load: 3, optionality: -2 },
          rationale: "Рост можно ускорить, пока нагрузка остаётся управляемой.",
        },
      ],
    },
    {
      id: "a2",
      name: "Активные пользователи",
      type: "user",
      weight: 4,
      goals: ["Получить понятную выгоду и не потерять доверие к продукту"],
      likelyMoves: ["Приглашать друзей", "Игнорировать механику"],
      adaptationRules: [
        {
          id: "r1",
          label: "Участие при понятной выгоде",
          priority: 1,
          when: [{ variableId: "trust", op: "gt", value: 50 }],
          move: "Активно приглашать знакомых с высоким намерением покупки",
          impacts: { adoption: 8, trust: 2, support_load: 2 },
          rationale: "Доверие превращает механику в добровольный канал роста.",
        },
      ],
    },
    {
      id: "a3",
      name: "Новые пользователи",
      type: "user",
      weight: 4,
      goals: ["Быстро понять ценность продукта и сделать первый заказ"],
      likelyMoves: ["Совершить первый заказ", "Зарегистрироваться без покупки"],
      adaptationRules: [
        {
          id: "r1",
          label: "Покупка при низком трении",
          priority: 1,
          when: [{ variableId: "activation_friction", op: "lt", value: 45 }],
          move: "Делать первый заказ после приглашения",
          impacts: { adoption: 6, trust: 2, optionality: 1 },
          rationale: "Низкое трение превращает приглашение в реальную активацию.",
        },
      ],
    },
  ],
  assumptions: [
    "Пилот ограничен одной аудиторией, чтобы ранние сигналы были видны до масштабирования.",
    "Экономика бонусов зависит от доли приглашённых пользователей, которые делают первый заказ.",
  ],
  stateVariables: [
    {
      id: "adoption",
      name: "Принятие механики",
      description: "Доля пользователей, которые понимают и используют реферальный сценарий.",
      initialValue: 42,
      targetDirection: "up",
    },
    {
      id: "trust",
      name: "Доверие к программе",
      description: "Ощущение честности и полезности программы у участников.",
      initialValue: 56,
      targetDirection: "up",
    },
    {
      id: "support_load",
      name: "Нагрузка поддержки",
      description: "Операционная нагрузка от вопросов, споров и ручных проверок.",
      initialValue: 35,
      targetDirection: "down",
    },
    {
      id: "abuse_pressure",
      name: "Давление злоупотреблений",
      description: "Попытки использовать бонусы без реальной ценности для продукта.",
      initialValue: 28,
      targetDirection: "down",
    },
    {
      id: "activation_friction",
      name: "Трение первой покупки",
      description: "Сложность пути от приглашения до первого заказа.",
      initialValue: 46,
      targetDirection: "down",
    },
    {
      id: "optionality",
      name: "Пространство будущих манёвров",
      description: "Насколько легко менять условия программы после запуска.",
      initialValue: 66,
      targetDirection: "up",
    },
  ],
  feedbackLoops: [
    {
      id: "loop_1",
      type: "reinforcing",
      label: "Доверие усиливает приглашения",
      description: "Чем выше доверие, тем чаще пользователи приглашают качественных новых покупателей.",
      impacts: { adoption: 3, trust: 1 },
    },
    {
      id: "loop_2",
      type: "balancing",
      label: "Нагрузка поддержки ограничивает рост",
      description: "Рост обращений замедляет масштабирование и ухудшает восприятие механики.",
      impacts: { support_load: 2, trust: -2, optionality: -1 },
    },
  ],
  tippingPoints: [
    {
      id: "tip_1",
      label: "Перегрузка поддержки",
      variableId: "support_load",
      threshold: 70,
      direction: "up",
      consequence: "Команда теряет способность быстро чинить сценарий и доверие падает.",
    },
    {
      id: "tip_2",
      label: "Захват механики бонусными охотниками",
      variableId: "abuse_pressure",
      threshold: 65,
      direction: "up",
      consequence: "Программа начинает привлекать пользователей без долгосрочной ценности.",
    },
  ],
  pathDependencies: [
    {
      id: "path_1",
      earlyCondition: "Если сразу запустить широкий бонус без ограничений аудитории.",
      laterEffect: "Правила станет трудно ужесточить без конфликта с активными участниками.",
      reversibility: "hard",
    },
  ],
  interventions: [
    {
      id: "i1",
      timing: "prelaunch",
      label: "Ограниченный пилот",
      description: "Запуск на малом сегменте с недельным окном наблюдения за ранними сигналами.",
      intendedImpacts: { abuse_pressure: -5, optionality: 7, adoption: -2 },
      tradeoffs: ["Медленнее рост", "Выше качество выводов"],
    },
  ],
  scenarios: [
    { id: "baseline", label: "Базовый сценарий", description: "Рост идёт умеренно, команда успевает реагировать.", shocks: { adoption: 0 } },
    { id: "upside", label: "Сценарий ускоренного роста", description: "Доверие и качество приглашений усиливают принятие механики.", shocks: { adoption: 5, trust: 4 } },
    { id: "stress", label: "Стресс-сценарий", description: "Злоупотребления и нагрузка поддержки растут раньше, чем польза.", shocks: { abuse_pressure: 7, support_load: 5, trust: -4 } },
  ],
};

export const complexityDecisionFixture: ComplexityDecisionResponse = {
  executiveSummary: "Запуск возможен только через ограниченный пилот: система сохраняет пространство манёвров, но ранний широкий запуск повышает риск захвата траектории.",
  resilienceScore: 68,
  adaptationCapacity: 72,
  lockInRisk: 54,
  cascadeRisk: 46,
  optionalityScore: 71,
  confidence: 82,
  verdict: "revise",
  verdictLabel: "Доработать условия пилота",
  earlySignals: ["Рост обращений в поддержку в первые два шага", "Доля приглашённых без первого заказа"],
  regimeShiftTriggers: ["Давление злоупотреблений выше 65", "Нагрузка поддержки выше 70"],
  keyInsights: ["Главная нелинейность возникает между доверием и качеством приглашений."],
  recommendations: ["Запускать пилот на ограниченной аудитории", "Заранее определить пороги остановки и ужесточения правил"],
};

export function buildComplexitySmokeFixture() {
  const setup = normalizeComplexitySetup(complexitySetupFixture, "Пилот реферальной программы");
  const simulation = simulateComplexitySystem(setup);
  const decision = normalizeComplexityDecision(complexityDecisionFixture, simulation);
  const result = composeComplexityResult(
    setup.title,
    setup,
    simulation,
    decision,
    "Ограниченная адаптивная симуляция показывает, что качество ранних приглашений важнее скорости масштабирования.",
    { durationMs: 1200, chunks: 3 },
  );

  assertComplexityGuardrails(result);
  return result;
}

export const complexitySmokeFixture = buildComplexitySmokeFixture();
