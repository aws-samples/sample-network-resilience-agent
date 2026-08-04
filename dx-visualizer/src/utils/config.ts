// Centralized app configuration.
// Override any value via VITE_* environment variables (or .env file).
// See .env.example for available options.

import type { MockScenario } from './shared';

export const config = {
  /** Bedrock model ID (without cross-region prefix). */
  bedrockModelId: import.meta.env.VITE_BEDROCK_MODEL_ID || 'global.anthropic.claude-opus-5',

  /** Default AWS region used when no credentials are provided. */
  defaultRegion: import.meta.env.VITE_DEFAULT_REGION || 'us-east-1',

  /** Max tool-use rounds per chat turn. */
  maxToolRounds: Number(import.meta.env.VITE_MAX_TOOL_ROUNDS) || 5,

  /** Default mock scenario shown on first load. */
  defaultScenario: (import.meta.env.VITE_DEFAULT_SCENARIO || 'noResiliency') as MockScenario,

  /** App title shown in the top bar. */
  appTitle: import.meta.env.VITE_APP_TITLE || 'Network Resilience Agent',

  /** Bedrock Guardrail identifier (created in the Bedrock console). */
  bedrockGuardrailId: import.meta.env.VITE_BEDROCK_GUARDRAIL_ID || '',

  /** Bedrock Guardrail version (e.g. "1" or "DRAFT"). */
  bedrockGuardrailVersion: import.meta.env.VITE_BEDROCK_GUARDRAIL_VERSION || 'DRAFT',

  /** App version from package.json, injected at build time. */
  appVersion: __APP_VERSION__,
} as const;
