import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type Message,
  type ContentBlock,
  type ToolConfiguration,
  type ToolUseBlock,
  type ToolResultBlock,
  type GuardrailConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import type { AwsCredentials } from '../types/aws-resources';
import { executeTool } from './tool-executor';
import { config } from '../utils/config';

const MAX_TOOL_ROUNDS = config.maxToolRounds;
const BASE_MODEL_ID = config.bedrockModelId;

function getGuardrailConfig(): GuardrailConfiguration | undefined {
  if (!config.bedrockGuardrailId) return undefined;
  return {
    guardrailIdentifier: config.bedrockGuardrailId,
    guardrailVersion: config.bedrockGuardrailVersion || 'DRAFT',
  };
}

// Map AWS region to cross-region inference profile prefix.
// If BASE_MODEL_ID already starts with a known inference-profile prefix
// (e.g. `global.`, `us.`, `eu.`, `apac.`), use it verbatim.
function getCrossRegionModelId(region: string): string {
  if (/^(global|us|eu|apac)\./.test(BASE_MODEL_ID)) return BASE_MODEL_ID;
  if (region.startsWith('us-')) return `us.${BASE_MODEL_ID}`;
  if (region.startsWith('eu-')) return `eu.${BASE_MODEL_ID}`;
  if (region.startsWith('ap-')) return `apac.${BASE_MODEL_ID}`;
  return `us.${BASE_MODEL_ID}`; // fallback to US
}

export function createBedrockClient(creds: AwsCredentials): BedrockRuntimeClient {
  return new BedrockRuntimeClient({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

export async function streamChat(
  client: BedrockRuntimeClient,
  systemPrompt: string,
  messages: Message[],
  onToken: (fullText: string) => void,
  toolConfig?: ToolConfiguration,
  region?: string,
  signal?: AbortSignal
): Promise<string> {
  const modelId = region ? getCrossRegionModelId(region) : `us.${BASE_MODEL_ID}`;
  const conversationMessages: Message[] = [...messages];
  let fullTextForUser = '';
  let lastStopReason = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const guardrailConfig = getGuardrailConfig();
    const command = new ConverseStreamCommand({
      modelId,
      system: [{ text: systemPrompt }],
      messages: conversationMessages,
      inferenceConfig: {
        maxTokens: 2048,
      },
      ...(toolConfig ? { toolConfig } : {}),
      ...(guardrailConfig ? { guardrailConfig } : {}),
    });

    const response = await client.send(command, { abortSignal: signal });

    // Track content blocks by index
    const blocks: Map<number, { type: 'text'; text: string } | { type: 'toolUse'; toolUseId: string; name: string; inputJson: string }> = new Map();
    let currentBlockIndex = -1;
    let stopReason = '';

    if (response.stream) {
      for await (const event of response.stream) {
        if (signal?.aborted) break;
        if (event.contentBlockStart) {
          currentBlockIndex = event.contentBlockStart.contentBlockIndex ?? currentBlockIndex + 1;
          if (event.contentBlockStart.start?.toolUse) {
            blocks.set(currentBlockIndex, {
              type: 'toolUse',
              toolUseId: event.contentBlockStart.start.toolUse.toolUseId ?? '',
              name: event.contentBlockStart.start.toolUse.name ?? '',
              inputJson: '',
            });
          } else {
            blocks.set(currentBlockIndex, { type: 'text', text: '' });
          }
        }

        if (event.contentBlockDelta) {
          const idx = event.contentBlockDelta.contentBlockIndex ?? currentBlockIndex;
          const block = blocks.get(idx);

          if (event.contentBlockDelta.delta?.text) {
            const text = event.contentBlockDelta.delta.text;
            if (block?.type === 'text') {
              block.text += text;
            }
            fullTextForUser += text;
            onToken(fullTextForUser);
          }

          if (event.contentBlockDelta.delta?.toolUse?.input) {
            if (block?.type === 'toolUse') {
              block.inputJson += event.contentBlockDelta.delta.toolUse.input;
            }
          }
        }

        if (event.messageStop) {
          stopReason = event.messageStop.stopReason ?? '';
        }
      }
    }

    // Build assistant content blocks for conversation history
    const assistantContent: ContentBlock[] = [];
    for (const [, block] of blocks) {
      if (block.type === 'text' && block.text) {
        assistantContent.push({ text: block.text });
      } else if (block.type === 'toolUse') {
        let parsedInput: Record<string, unknown> = {};
        try {
          parsedInput = block.inputJson ? JSON.parse(block.inputJson) : {};
        } catch { /* empty input is fine */ }
        assistantContent.push({
          toolUse: {
            toolUseId: block.toolUseId,
            name: block.name,
            input: parsedInput,
          } as ToolUseBlock,
        });
      }
    }

    conversationMessages.push({ role: 'assistant', content: assistantContent });
    lastStopReason = stopReason;

    if (signal?.aborted) break;

    if (stopReason === 'tool_use') {
      // Execute all tool calls and send results back
      const toolResultBlocks: ContentBlock[] = [];
      for (const [, block] of blocks) {
        if (block.type !== 'toolUse') continue;
        let parsedInput: Record<string, unknown> = {};
        try {
          parsedInput = block.inputJson ? JSON.parse(block.inputJson) : {};
        } catch { /* use empty */ }

        const result = await executeTool(block.name, parsedInput);
        toolResultBlocks.push({
          toolResult: {
            toolUseId: block.toolUseId,
            content: result.content.map((c) => ({ text: c.text })),
            status: result.status,
          } as ToolResultBlock,
        });
      }

      conversationMessages.push({ role: 'user', content: toolResultBlocks });
      // Add visual separator so the next round's text starts on a new section
      if (fullTextForUser.trim()) {
        fullTextForUser += '\n\n---\n\n';
        onToken(fullTextForUser);
      }
      // Continue loop — model will process tool results
    } else {
      // end_turn or max_tokens — done
      break;
    }
  }

  // If we exited the loop while still mid-tool-use, the last round's tool
  // results were appended to history but never synthesized by the model. Run
  // one final round without toolConfig so the model is forced to produce text.
  if (lastStopReason === 'tool_use' && !signal?.aborted) {
    const finalGuardrailConfig = getGuardrailConfig();
    const finalCommand = new ConverseStreamCommand({
      modelId,
      system: [{ text: systemPrompt }],
      messages: conversationMessages,
      inferenceConfig: { maxTokens: 2048 },
      ...(finalGuardrailConfig ? { guardrailConfig: finalGuardrailConfig } : {}),
    });
    const finalResponse = await client.send(finalCommand, { abortSignal: signal });
    if (fullTextForUser.trim()) {
      fullTextForUser += '\n\n---\n\n';
      onToken(fullTextForUser);
    }
    if (finalResponse.stream) {
      for await (const event of finalResponse.stream) {
        if (signal?.aborted) break;
        const text = event.contentBlockDelta?.delta?.text;
        if (text) {
          fullTextForUser += text;
          onToken(fullTextForUser);
        }
      }
    }
  }

  const cleaned = fullTextForUser.replace(/\n\n---\n\n/g, '\n\n');
  if (cleaned !== fullTextForUser) onToken(cleaned);
  return cleaned;
}
