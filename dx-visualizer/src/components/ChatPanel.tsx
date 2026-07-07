import { useEffect, useRef } from 'react';
import { useTopologyStore, type ChatMessage as ChatMessageType } from '../store/topology-store';
import { useIsLight } from '../hooks/useTheme';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { ChatSuggestions } from './ChatSuggestions';
import { sendChatMessage } from '../chat/chat-service';
import { classifyChatError, encodeChatError } from '../chat/chat-error';

export function ChatPanel() {
  const messages = useTopologyStore((s) => s.chatMessages);
  const isChatLoading = useTopologyStore((s) => s.isChatLoading);
  const addChatMessage = useTopologyStore((s) => s.addChatMessage);
  const updateLastAssistantMessage = useTopologyStore((s) => s.updateLastAssistantMessage);
  const setIsChatLoading = useTopologyStore((s) => s.setIsChatLoading);
  const topologyData = useTopologyStore((s) => s.topologyData);
  const assessment = useTopologyStore((s) => s.assessment);
  const credentials = useTopologyStore((s) => s.credentials);
  const bedrockStatus = useTopologyStore((s) => s.bedrockStatus);
  const clearChat = useTopologyStore((s) => s.clearChat);
  const setChatAbortController = useTopologyStore((s) => s.setChatAbortController);
  const cancelChat = useTopologyStore((s) => s.cancelChat);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const light = useIsLight();

  const hasUserMessages = messages.some((m) => m.role === 'user');

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Stream one turn into the current (empty) trailing assistant message.
  // `history` must be the messages BEFORE the user turn — sendChatMessage
  // appends `userContent` itself.
  const runTurn = async (userContent: string, history: ChatMessageType[]) => {
    setIsChatLoading(true);
    const controller = new AbortController();
    setChatAbortController(controller);

    try {
      await sendChatMessage(
        userContent,
        history,
        topologyData,
        assessment,
        credentials,
        (token) => {
          updateLastAssistantMessage(token);
        },
        controller.signal
      );
    } catch (err) {
      // Backstop for unexpected throws; chat-service already encodes its own
      // failures. Don't overwrite the message on user cancellation.
      if (!controller.signal.aborted) {
        updateLastAssistantMessage(encodeChatError(classifyChatError(err)));
      }
    } finally {
      setChatAbortController(null);
      setIsChatLoading(false);
    }
  };

  const handleSend = async (content: string) => {
    const history = messages;
    addChatMessage({
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    });
    addChatMessage({
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    });
    await runTurn(content, history);
  };

  // Re-run the most recent turn after a failure. The trailing assistant message
  // holds the error marker; reset it to empty and stream into the same slot,
  // resending the user message that preceded it.
  const handleRetry = async () => {
    if (isChatLoading) return;
    const msgs = messages;
    let userIdx = msgs.length - 2; // skip the trailing assistant error slot
    while (userIdx >= 0 && msgs[userIdx].role !== 'user') userIdx--;
    if (userIdx < 0) return;

    const userContent = msgs[userIdx].content;
    const history = msgs.slice(0, userIdx);
    updateLastAssistantMessage(''); // clear the error so the box becomes a fresh stream
    await runTurn(userContent, history);
  };

  return (
    <div className={`flex flex-col h-full ${light ? 'chat-bg-light' : 'chat-bg-dark'}`}>
      <div className={`flex items-center justify-between px-4 py-3 border-b ${light ? 'border-gray-300/60 bg-white/70 backdrop-blur-sm' : 'border-slate-700/60 bg-slate-900/80 backdrop-blur-sm'}`}>
        <div className="flex items-center gap-3">
          <div>
            {/* Status pill badge — "ready" (credentials present, awaiting first
                message) and "connected" both render green so the pre-connect
                state doesn't look like an error or an inactive session. */}
            {(() => {
              const isGreen = bedrockStatus === 'connected' || (bedrockStatus !== 'error' && !!credentials);
              const isRed = bedrockStatus === 'error';
              const pillClass = isGreen
                ? light ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                : isRed
                  ? light ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-red-500/10 text-red-400 border border-red-500/20'
                  : light ? 'bg-gray-200/80 text-gray-500 border border-gray-300' : 'bg-slate-700/50 text-slate-400 border border-slate-600/50';
              const dotClass = isGreen
                ? 'bg-emerald-500'
                : isRed
                  ? 'bg-red-500'
                  : light ? 'bg-gray-400' : 'bg-slate-500';
              const label = bedrockStatus === 'connected'
                ? 'Bedrock connected'
                : bedrockStatus === 'error'
                  ? 'Connection failed'
                  : credentials
                    ? 'Ready — send a message to connect'
                    : 'Not connected';
              return (
                <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium ${pillClass}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
                  {label}
                </div>
              );
            })()}
          </div>
        </div>
        {hasUserMessages && (
          <button
            onClick={clearChat}
            title="Clear chat"
            aria-label="Clear chat history"
            className={`p-1.5 rounded-md transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
              light ? 'text-gray-400 hover:text-red-500 hover:bg-gray-100' : 'text-slate-500 hover:text-red-400 hover:bg-slate-800'
            }`}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {messages.map((msg, i) => (
          <ChatMessage
            key={msg.id}
            role={msg.role}
            content={msg.content}
            timestamp={msg.timestamp}
            isStreaming={isChatLoading && i === messages.length - 1}
            isFirstMessage={i === 0}
            onRetry={i === messages.length - 1 && !isChatLoading ? handleRetry : undefined}
          />
        ))}
        {!hasUserMessages && !isChatLoading && (
          <ChatSuggestions onSelect={handleSend} />
        )}
        {isChatLoading && messages[messages.length - 1]?.content === '' && (
          <div className="flex justify-start mb-3">
            <div className={`rounded-xl px-4 py-2.5 ${light ? 'bg-gray-100/80 border border-gray-200/60' : 'bg-slate-800/60 border border-slate-700/40'}`}>
              <div className="flex items-center gap-2.5">
                <div className={`w-5 h-5 rounded-md flex items-center justify-center ${light ? 'bg-violet-100' : 'bg-violet-500/15'}`}>
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke={light ? '#7c3aed' : '#a78bfa'} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2L2 7l10 5 10-5-10-5z" />
                    <path d="M2 17l10 5 10-5" />
                    <path d="M2 12l10 5 10-5" />
                  </svg>
                </div>
                <span className={`text-[11px] font-medium ${light ? 'text-gray-500' : 'text-slate-400'}`}>Analyzing...</span>
              </div>
              <div className={`mt-2 h-1 rounded-full overflow-hidden ${light ? 'bg-gray-200' : 'bg-slate-700'}`}>
                <div className={`h-full rounded-full ${light ? 'thinking-shimmer-light' : 'thinking-shimmer'}`} />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <ChatInput onSend={handleSend} onStop={cancelChat} disabled={isChatLoading} />
    </div>
  );
}
