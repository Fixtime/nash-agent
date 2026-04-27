import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { LlmProvider, PublicAppSettings, SettingsPayload } from "@/lib/settings-types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Loader2,
  Save,
  Server,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";

const EMPTY_SETTINGS: PublicAppSettings = {
  llmProvider: "local",
  local: {
    baseURL: "http://127.0.0.1:1234/v1",
    model: "auto",
    timeoutMs: 900000,
    apiKeySet: true,
  },
  yandex: {
    baseURL: "https://ai.api.cloud.yandex.net/v1",
    model: "gpt://b1gjb9f0e5t7ii1s2p9l/qwen3.5-35b-a3b-fp8/latest",
    projectId: "b1gjb9f0e5t7ii1s2p9l",
    timeoutMs: 900000,
    maxOutputTokens: 40000,
    temperature: 0.8,
    apiKeySet: false,
  },
};

function toNumber(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ProviderChoice({
  value,
  title,
  subtitle,
  icon: Icon,
  active,
}: {
  value: LlmProvider;
  title: string;
  subtitle: string;
  icon: typeof Server;
  active: boolean;
}) {
  return (
    <Label
      htmlFor={`provider-${value}`}
      className={`flex min-h-[112px] cursor-pointer items-start gap-4 rounded-lg border p-4 transition-colors ${
        active ? "border-primary bg-primary/10" : "border-card-border bg-card hover:bg-muted/30"
      }`}
    >
      <RadioGroupItem id={`provider-${value}`} value={value} className="mt-1" />
      <div className="flex min-w-0 flex-1 gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-foreground">{title}</span>
            {active && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <CheckCircle2 className="h-3 w-3" />
                Активна
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
        </div>
      </div>
    </Label>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

export default function Settings() {
  const { toast } = useToast();
  const { data, isLoading, error } = useQuery<PublicAppSettings>({
    queryKey: ["/api/settings"],
  });
  const settings = data || EMPTY_SETTINGS;

  const [provider, setProvider] = useState<LlmProvider>(settings.llmProvider);
  const [localBaseURL, setLocalBaseURL] = useState(settings.local.baseURL);
  const [localModel, setLocalModel] = useState(settings.local.model);
  const [localApiKey, setLocalApiKey] = useState("");
  const [localTimeoutMs, setLocalTimeoutMs] = useState(String(settings.local.timeoutMs));
  const [yandexBaseURL, setYandexBaseURL] = useState(settings.yandex.baseURL);
  const [yandexProjectId, setYandexProjectId] = useState(settings.yandex.projectId || "");
  const [yandexModel, setYandexModel] = useState(settings.yandex.model);
  const [yandexApiKey, setYandexApiKey] = useState("");
  const [yandexTemperature, setYandexTemperature] = useState(String(settings.yandex.temperature ?? 0.8));
  const [yandexMaxTokens, setYandexMaxTokens] = useState(String(settings.yandex.maxOutputTokens ?? 40000));
  const [yandexTimeoutMs, setYandexTimeoutMs] = useState(String(settings.yandex.timeoutMs));

  useEffect(() => {
    if (!data) return;
    setProvider(data.llmProvider);
    setLocalBaseURL(data.local.baseURL);
    setLocalModel(data.local.model);
    setLocalApiKey("");
    setLocalTimeoutMs(String(data.local.timeoutMs));
    setYandexBaseURL(data.yandex.baseURL);
    setYandexProjectId(data.yandex.projectId || "");
    setYandexModel(data.yandex.model);
    setYandexApiKey("");
    setYandexTemperature(String(data.yandex.temperature ?? 0.8));
    setYandexMaxTokens(String(data.yandex.maxOutputTokens ?? 40000));
    setYandexTimeoutMs(String(data.yandex.timeoutMs));
  }, [data]);

  const payload = useMemo<SettingsPayload>(
    () => ({
      llmProvider: provider,
      local: {
        baseURL: localBaseURL,
        model: localModel,
        timeoutMs: toNumber(localTimeoutMs, settings.local.timeoutMs),
        ...(localApiKey.trim() ? { apiKey: localApiKey.trim() } : {}),
      },
      yandex: {
        baseURL: yandexBaseURL,
        projectId: yandexProjectId,
        model: yandexModel,
        temperature: Number.isFinite(Number(yandexTemperature)) ? Number(yandexTemperature) : 0.8,
        maxOutputTokens: toNumber(yandexMaxTokens, 40000),
        timeoutMs: toNumber(yandexTimeoutMs, settings.yandex.timeoutMs),
        ...(yandexApiKey.trim() ? { apiKey: yandexApiKey.trim() } : {}),
      },
    }),
    [
      localApiKey,
      localBaseURL,
      localModel,
      localTimeoutMs,
      provider,
      settings.local.timeoutMs,
      settings.yandex.timeoutMs,
      yandexApiKey,
      yandexBaseURL,
      yandexMaxTokens,
      yandexModel,
      yandexProjectId,
      yandexTemperature,
      yandexTimeoutMs,
    ],
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("PUT", "/api/settings", payload);
      return await response.json() as PublicAppSettings;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["/api/settings"], updated);
      toast({
        title: "Настройки сохранены",
        description: updated.llmProvider === "yandex" ? "Активна Yandex AI Studio" : "Активна локальная LLM",
      });
    },
    onError: (mutationError) => {
      toast({
        title: "Не удалось сохранить настройки",
        description: mutationError instanceof Error ? mutationError.message : "Попробуйте ещё раз",
        variant: "destructive",
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      await saveMutation.mutateAsync();
      const response = await apiRequest("POST", "/api/settings/test-llm");
      return await response.json() as { ok: boolean; model: string; response: string };
    },
    onSuccess: (result) => {
      toast({
        title: "LLM отвечает",
        description: result.model,
      });
    },
    onError: (mutationError) => {
      toast({
        title: "LLM не ответила",
        description: mutationError instanceof Error ? mutationError.message : "Проверьте параметры подключения",
        variant: "destructive",
      });
    },
  });

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Настройки</h1>
          <p className="mt-1 text-sm text-muted-foreground">Источник LLM для новых анализов агента</p>
        </div>
        <Badge variant={provider === "yandex" ? "default" : "secondary"} className="gap-1">
          {provider === "yandex" ? <Cloud className="h-3.5 w-3.5" /> : <Server className="h-3.5 w-3.5" />}
          {provider === "yandex" ? "Yandex AI Studio" : "Локальная LLM"}
        </Badge>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Настройки недоступны</AlertTitle>
          <AlertDescription>{error instanceof Error ? error.message : "Ошибка загрузки"}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <SlidersHorizontal className="h-4 w-4 text-primary" />
                Провайдер
              </CardTitle>
            </CardHeader>
            <CardContent>
              <RadioGroup value={provider} onValueChange={(value) => setProvider(value as LlmProvider)} className="grid gap-3 md:grid-cols-2">
                <ProviderChoice
                  value="local"
                  title="Локальная LLM"
                  subtitle="LM Studio на локальном OpenAI-compatible endpoint."
                  icon={Server}
                  active={provider === "local"}
                />
                <ProviderChoice
                  value="yandex"
                  title="Yandex AI Studio"
                  subtitle="Облачная модель через OpenAI-compatible API Yandex Cloud."
                  icon={Cloud}
                  active={provider === "yandex"}
                />
              </RadioGroup>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <Server className="h-4 w-4 text-primary" />
                Локальная LLM
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <Field id="local-base-url" label="Base URL">
                <Input id="local-base-url" value={localBaseURL} onChange={(event) => setLocalBaseURL(event.target.value)} />
              </Field>
              <Field id="local-model" label="Модель">
                <Input id="local-model" value={localModel} onChange={(event) => setLocalModel(event.target.value)} />
              </Field>
              <Field id="local-api-key" label="API key">
                <Input
                  id="local-api-key"
                  type="password"
                  value={localApiKey}
                  placeholder={settings.local.apiKeySet ? "Ключ сохранён. Оставьте пустым, чтобы не менять" : "Введите ключ"}
                  onChange={(event) => setLocalApiKey(event.target.value)}
                />
              </Field>
              <Field id="local-timeout" label="Таймаут, мс">
                <Input id="local-timeout" value={localTimeoutMs} onChange={(event) => setLocalTimeoutMs(event.target.value)} />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <Cloud className="h-4 w-4 text-primary" />
                Yandex AI Studio
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <Field id="yandex-base-url" label="Base URL">
                <Input id="yandex-base-url" value={yandexBaseURL} onChange={(event) => setYandexBaseURL(event.target.value)} />
              </Field>
              <Field id="yandex-project-id" label="OpenAI-Project">
                <Input id="yandex-project-id" value={yandexProjectId} onChange={(event) => setYandexProjectId(event.target.value)} />
              </Field>
              <div className="md:col-span-2">
                <Field id="yandex-model" label="Модель">
                  <Input id="yandex-model" value={yandexModel} onChange={(event) => setYandexModel(event.target.value)} />
                </Field>
              </div>
              <Field id="yandex-api-key" label="API key">
                <Input
                  id="yandex-api-key"
                  type="password"
                  value={yandexApiKey}
                  placeholder={settings.yandex.apiKeySet ? "Ключ сохранён. Оставьте пустым, чтобы не менять" : "Введите ключ Yandex AI Studio"}
                  onChange={(event) => setYandexApiKey(event.target.value)}
                />
              </Field>
              <Field id="yandex-temperature" label="Температура">
                <Input id="yandex-temperature" value={yandexTemperature} onChange={(event) => setYandexTemperature(event.target.value)} />
              </Field>
              <Field id="yandex-max-tokens" label="Max output tokens">
                <Input id="yandex-max-tokens" value={yandexMaxTokens} onChange={(event) => setYandexMaxTokens(event.target.value)} />
              </Field>
              <Field id="yandex-timeout" label="Таймаут, мс">
                <Input id="yandex-timeout" value={yandexTimeoutMs} onChange={(event) => setYandexTimeoutMs(event.target.value)} />
              </Field>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4 text-primary" />
                Активное подключение
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-card-border bg-secondary/40 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Провайдер</div>
                <div className="mt-2 text-lg font-semibold text-foreground">
                  {provider === "yandex" ? "Yandex AI Studio" : "Локальная LLM"}
                </div>
                <div className="mt-1 break-words text-sm text-muted-foreground">
                  {provider === "yandex" ? yandexModel : localModel}
                </div>
              </div>

              <Button
                className="w-full gap-2"
                onClick={() => saveMutation.mutate()}
                disabled={isLoading || saveMutation.isPending || testMutation.isPending}
              >
                {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Сохранить
              </Button>
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={() => testMutation.mutate()}
                disabled={isLoading || saveMutation.isPending || testMutation.isPending}
              >
                {testMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Проверить LLM
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
