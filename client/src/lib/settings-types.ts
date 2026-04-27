export type LlmProvider = "local" | "yandex";

export interface PublicProviderSettings {
  baseURL: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens?: number;
  temperature?: number;
  projectId?: string;
  apiKeySet: boolean;
}

export interface PublicAppSettings {
  llmProvider: LlmProvider;
  local: PublicProviderSettings;
  yandex: PublicProviderSettings;
}

export interface SettingsPayload {
  llmProvider: LlmProvider;
  local: Partial<PublicProviderSettings> & { apiKey?: string };
  yandex: Partial<PublicProviderSettings> & { apiKey?: string };
}
