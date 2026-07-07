import type { Message } from '@aws-sdk/client-bedrock-runtime';
import type { AwsCredentials } from '../types/aws-resources';
import type { TopologyData } from '../types/topology';
import type { CombinedAssessment } from '../types/recommendations';
import { type ChatMessage, useTopologyStore } from '../store/topology-store';
import { createBedrockClient, streamChat } from './bedrock-client';
import { buildSystemPrompt } from './system-prompt';
import { TOOL_CONFIG } from './tool-definitions';
import { classifyChatError, encodeChatError } from './chat-error';

// Cache system prompt — only rebuild when topology or assessment data changes
let cachedSystemPrompt: string | null = null;
let cachedTopologyRef: TopologyData | null = null;
let cachedAssessmentRef: CombinedAssessment | null = null;

function getSystemPrompt(topology: TopologyData | null, assessment: CombinedAssessment | null): string {
  if (cachedSystemPrompt && topology === cachedTopologyRef && assessment === cachedAssessmentRef) {
    return cachedSystemPrompt;
  }
  cachedTopologyRef = topology;
  cachedAssessmentRef = assessment;
  cachedSystemPrompt = buildSystemPrompt(topology, assessment);
  return cachedSystemPrompt;
}

const MAX_MESSAGE_LENGTH = 4000;

export async function sendChatMessage(
  userMessage: string,
  history: ChatMessage[],
  topology: TopologyData | null,
  assessment: CombinedAssessment | null,
  credentials: AwsCredentials | null,
  onToken: (fullText: string) => void,
  signal?: AbortSignal
): Promise<string> {
  if (userMessage.length > MAX_MESSAGE_LENGTH) {
    const msg = `Message too long (${userMessage.length} characters). Please keep messages under ${MAX_MESSAGE_LENGTH} characters.`;
    onToken(msg);
    return msg;
  }

  if (!credentials) {
    const msg = 'Please connect to AWS first using the **Connect AWS** button in the top bar. The chat requires an active AWS Bedrock connection.';
    onToken(msg);
    return msg;
  }

  const client = createBedrockClient(credentials);
  const systemPrompt = getSystemPrompt(topology, assessment);

  // Build conversation history as proper Message[] with ContentBlock[]
  const conversationHistory: Message[] = history
    .filter((m) => m.role !== 'system' && m.content.length > 0)
    .slice(-10)
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: [{ text: m.content }],
    }));

  // Add current user message
  conversationHistory.push({ role: 'user', content: [{ text: userMessage }] });

  try {
    const result = await streamChat(client, systemPrompt, conversationHistory, onToken, TOOL_CONFIG, credentials.region, signal);
    useTopologyStore.getState().setBedrockStatus('connected');
    return result;
  } catch (err) {
    // Intentional user cancellation — don't write an error into the chat.
    if (signal?.aborted || (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))) {
      return '';
    }
    useTopologyStore.getState().setBedrockStatus('error');
    const info = classifyChatError(err);
    onToken(encodeChatError(info));
    return info.detail;
  }
}
