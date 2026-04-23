import type { Express, Request, Response } from "express";
import type { Server } from "http";
import OpenAI from "openai";
import {
  insertAnalysisSchema,
  type AnalysisResult,
  type DeviationCheck,
  type NashScenario,
  type PairwiseView,
  type PayoffCell,
  type Player,
  type SensitivityCheck,
  type StrategyProfile,
} from "@shared/schema";
import { storage } from "./storage";

const MAX_CORE_PLAYERS = 5;
const MAX_PROFILE_BUDGET = 64;

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

interface PreparedPlayers {
  players: Player[];
  notes: string[];
}

type AnalysisProgressPhase = "queued" | "setup" | "payoff" | "finalizing" | "done" | "error" | "cancelled";

interface AnalysisLiveProgress {
  phase: AnalysisProgressPhase;
  phaseLabel: string;
  llmStatus: string;
  previewText: string;
  startedAt: number;
  updatedAt: number;
  lastChunkAt: number | null;
  chunks: number;
  error: string | null;
}

const MAX_STREAM_PREVIEW_CHARS = 24_000;
const ANALYSIS_PROGRESS_TTL_MS = 15 * 60 * 1000;
const analysisLiveProgress = new Map<number, AnalysisLiveProgress>();
const analysisProgressCleanupTimers = new Map<number, ReturnType<typeof setTimeout>>();
const activeAnalysisControllers = new Map<number, AbortController>();

class AnalysisCancelledError extends Error {
  constructor(message = "Анализ остановлен пользователем") {
    super(message);
    this.name = "AnalysisCancelledError";
  }
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
  analysisLiveProgress.delete(id);
  activeAnalysisControllers.delete(id);

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
      error: null,
    }, false);
  } else if (status === "cancelled") {
    appendLivePreview(id, `\n\n[cancelled] ${errorMessage || "Анализ остановлен пользователем"}\n`, {
      phase: "cancelled",
      phaseLabel: "Анализ остановлен",
      llmStatus: errorMessage || "Запрос к модели отменён",
      error: errorMessage || "Анализ остановлен пользователем",
    }, false);
  } else {
    appendLivePreview(id, `\n\n[error] ${errorMessage || "Анализ завершился ошибкой"}\n`, {
      phase: "error",
      phaseLabel: "Анализ завершился ошибкой",
      llmStatus: errorMessage || "Не удалось получить пригодный ответ от LLM",
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
Тип: ${type === "strategy" ? "Продуктовая стратегия" : "Фича / Feature"}
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

async function requestJson<T>(
  client: OpenAI,
  analysisId: number,
  model: string,
  phase: AnalysisProgressPhase,
  phaseLabel: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal
): Promise<T> {
  const baseURL = getConfiguredBaseUrl();
  const isLmStudio = isLmStudioBaseUrl(baseURL);
  const timeoutMs = getConfiguredTimeoutMs(baseURL);
  let lastError: unknown;
  const maxAttempts = 2;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    throwIfAborted(signal);
    try {
      const attemptLabel = attemptIndex === 0 ? phaseLabel : `${phaseLabel} · retry ${attemptIndex + 1}`;
      appendPhaseHeader(analysisId, attemptLabel);
      updateLiveProgress(analysisId, {
        phase,
        phaseLabel,
        llmStatus:
          attemptIndex === 0
            ? "Ждём первые токены от модели…"
            : "Повторяем запрос после невалидного или неполного ответа модели.",
        error: null,
      });

      const request: Record<string, unknown> = {
        model,
        messages: [
          {
            role: "system",
            content: isLmStudio
              ? `${systemPrompt}\n\nКРИТИЧНО: верни один валидный JSON-объект без markdown, без префиксов и без пояснений до или после JSON.`
              : systemPrompt,
          },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        stream: true,
      };

      if (!isLmStudio) {
        request.response_format = { type: "json_object" };
      }

      const responseStream = await client.chat.completions.create(
        request as never,
        { timeout: timeoutMs, signal },
      ) as unknown as AsyncIterable<any>;

      let content = "";
      let sawToken = false;
      let finishReason = "";

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
        }

        if (streamChunk) {
          appendLivePreview(analysisId, streamChunk, {
            phase,
            phaseLabel,
            llmStatus: "Стримим ответ модели…",
          });
        }

        if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }

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
      });

      return parseJsonFromCompletion<T>(content);
    } catch (error) {
      if (signal?.aborted || isAbortLikeError(error)) {
        throw new AnalysisCancelledError();
      }

      lastError = error;
      const errorMessage = getErrorMessage(error);
      const hasRetryLeft = attemptIndex < 1;

      appendLivePreview(
        analysisId,
        `\n\n[${phaseLabel}] ${hasRetryLeft ? "Попытка не удалась" : "Ошибка"}: ${errorMessage}\n`,
        {
          phase,
          phaseLabel,
          llmStatus: hasRetryLeft ? "Пробуем ещё раз…" : errorMessage,
          error: hasRetryLeft ? null : errorMessage,
        },
        false,
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error("LLM returned invalid JSON");
}

function getConfiguredBaseUrl(): string {
  return (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim();
}

function getConfiguredTimeoutMs(baseURL: string): number {
  const configured = Number.parseInt(process.env.LLM_TIMEOUT_MS || "", 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return isLmStudioBaseUrl(baseURL) ? 15 * 60 * 1000 : 2 * 60 * 1000;
}

function isLmStudioBaseUrl(baseURL: string): boolean {
  const normalized = baseURL.toLowerCase();
  return normalized.includes("127.0.0.1:1234") || normalized.includes("localhost:1234") || normalized.includes("lmstudio");
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

async function resolveConfiguredModel(baseURL: string, apiKey: string, signal?: AbortSignal): Promise<string> {
  const preferredModel = process.env.LLM_MODEL?.trim();
  if (preferredModel && preferredModel.toLowerCase() !== "auto") {
    return preferredModel;
  }

  const loadedLmStudioModel = await resolveLoadedLmStudioModel(baseURL, apiKey, signal);
  if (loadedLmStudioModel) {
    return loadedLmStudioModel;
  }

  const response = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
  const pairwiseViews = buildPairwiseViews(
    setup.players,
    assessment.profiles,
    gameAnalysis.equilibria,
    gameAnalysis.recommendedEquilibrium
  );
  const primaryPairwise = pairwiseViews[0];

  return {
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
    payoffMatrix: primaryPairwise?.matrix || [],
    matrixPlayers: primaryPairwise ? [...primaryPairwise.players] : [],
    matrixStrategies: primaryPairwise?.matrixStrategies || {},
    rawThinking: assessment.rawThinking,
  };
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
    "Выделение релевантных игроков",
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
  const raw = await requestJson<PayoffAssessmentResponse>(
    client,
    analysisId,
    model,
    "payoff",
    "Оценка strategy profiles",
    PAYOFF_SYSTEM_PROMPT,
    buildProfilesUserPrompt(
      data.type,
      data.title,
      data.description,
      data.context,
      players,
      assumptions,
      caseFrame,
      profiles,
      aggregatedActors
    ),
    signal
  );

  if (typeof raw.confidence !== "number") {
    throw new Error("LLM did not return confidence");
  }

  return {
    profiles: hydrateProfiles(profiles, raw.profiles, players),
    confidence: clamp(Math.round(raw.confidence), 20, 95),
    gameType: raw.gameType?.trim() || "",
    keyInsights: normalizeTextList(raw.keyInsights),
    breakEquilibriumMoves: normalizeTextList(raw.breakEquilibriumMoves),
    recommendations: normalizeTextList(raw.recommendations),
    sensitivityChecks: normalizeSensitivityChecks(raw.sensitivityChecks),
    rawThinking: raw.rawThinking?.trim() || "",
  };
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

function shouldUseLocalDebugLLM(): boolean {
  return String(process.env.DEBUG_LOCAL_LLM || "").toLowerCase() === "true";
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
    return res.json(item);
  });

  // ─── Create + run analysis ─────────────────────────────────────────────────
  app.post("/api/analyses", async (req, res) => {
    const parsed = insertAnalysisSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const analysis = storage.createAnalysis(parsed.data);
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

  app.post("/api/analyses/:id/delete", handleDeleteAnalysis);
  app.delete("/api/analyses/:id", handleDeleteAnalysis);

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
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
}

// ─── LLM Runner ──────────────────────────────────────────────────────────────
async function runAnalysis(
  id: number,
  data: { type: string; title: string; description: string; players: string; context: string }
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

  try {
    throwIfAborted(controller.signal);
    analysisLiveProgress.set(id, buildInitialLiveProgress());
    updateLiveProgress(id, {
      phase: "queued",
      phaseLabel: "Анализ запущен",
      llmStatus: "Готовим запрос к модели",
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
      });
      const result = runLocalDebugAnalysis(data);
      throwIfAborted(controller.signal);
      persistAnalysisResult(id, JSON.stringify(result), "done");
      finalizeLiveProgress(id, "done");
      return;
    }

    const hintedPlayers = parsePlayersInput(data.players);
    if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_BASE_URL) {
      throw new Error("LLM is not configured");
    }

    const baseURL = getConfiguredBaseUrl();
    const apiKey = process.env.OPENAI_API_KEY || "lm-studio";
    const client = new OpenAI({
      apiKey,
      baseURL,
      timeout: getConfiguredTimeoutMs(baseURL),
    });
    const model = await resolveConfiguredModel(baseURL, apiKey, controller.signal);
    throwIfAborted(controller.signal);
    console.info(`[llm] analysis ${id} using model "${model}" via ${baseURL}`);

    const strategicSetup = await inferStrategicSetup(client, id, model, data, hintedPlayers, controller.signal);
    throwIfAborted(controller.signal);
    const baseProfiles = buildStrategyProfiles(strategicSetup.players);
    updateLiveProgress(id, {
      phase: "payoff",
      phaseLabel: "Оценка strategy profiles",
      llmStatus: `Подготовили ${baseProfiles.length} профилей для оценки`,
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
    throwIfAborted(controller.signal);

    updateLiveProgress(id, {
      phase: "finalizing",
      phaseLabel: "Формирование итогового результата",
      llmStatus: "Ищем Nash-equilibria и собираем дашборд",
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
    const pairwiseViews = buildPairwiseViews(
      strategicSetup.players,
      payoffAssessment.profiles,
      gameAnalysis.equilibria,
      gameAnalysis.recommendedEquilibrium
    );
    const primaryPairwise = pairwiseViews[0];

    const result: AnalysisResult = {
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
      payoffMatrix: primaryPairwise?.matrix || [],
      matrixPlayers: primaryPairwise ? [...primaryPairwise.players] : [],
      matrixStrategies: primaryPairwise?.matrixStrategies || {},
      rawThinking: strategicSetup.caseFrame
        ? `${strategicSetup.caseFrame}\n\n${payoffAssessment.rawThinking}`
        : payoffAssessment.rawThinking,
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
    const errorMessage = getErrorMessage(err);
    persistAnalysisResult(
      id,
      JSON.stringify({ error: errorMessage }),
      "error"
    );
    finalizeLiveProgress(id, "error", errorMessage);
  } finally {
    activeAnalysisControllers.delete(id);
  }
}
