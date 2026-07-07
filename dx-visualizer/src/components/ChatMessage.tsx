import { memo, useState, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useIsLight } from '../hooks/useTheme';
import { COLORS } from '../utils/colors';
import { ChatActions, stripActionMarkers } from './ChatActions';
import { useRedact } from '../utils/redact';
import { decodeChatError } from '../chat/chat-error';

interface Props {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  isFirstMessage?: boolean;
  /** When provided on an error message, renders a Retry button. */
  onRetry?: () => void;
}

function formatRelativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function CodeBlock({ className, children, ...rest }: ComponentPropsWithoutRef<'code'>) {
  const [copied, setCopied] = useState(false);
  const light = useIsLight();
  const lang = className?.replace('language-', '') ?? '';
  const code = String(children).replace(/\n$/, '');

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative my-2 rounded-md overflow-hidden" style={{ backgroundColor: light ? COLORS.light.codeBg : COLORS.dark.codeBg }}>
      <div className="flex items-center justify-between px-3 py-1" style={{ backgroundColor: light ? COLORS.light.codeHeaderBg : COLORS.dark.codeHeaderBg }}>
        <span className="text-[10px] text-slate-400">{lang || 'code'}</span>
        <button
          onClick={handleCopy}
          className="text-[10px] text-slate-400 hover:text-white transition-colors cursor-pointer"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="px-3 py-2 overflow-x-auto">
        <code className={`text-[11px] text-slate-200 ${className ?? ''}`} style={{ fontFamily: "'JetBrains Mono', monospace" }} {...rest}>
          {children}
        </code>
      </pre>
    </div>
  );
}

const COLLAPSE_THRESHOLD = 1500;
const TRUNCATE_AT = 800;

export const ChatMessage = memo(function ChatMessage({ role, content, timestamp, isStreaming, isFirstMessage, onRetry }: Props) {
  const isUser = role === 'user';
  const light = useIsLight();
  const r = useRedact();
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);

  const errorInfo = !isUser ? decodeChatError(content) : null;

  const handleCopyMessage = () => {
    navigator.clipboard.writeText(stripActionMarkers(content));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (errorInfo) {
    return (
      <div className="flex justify-start mb-3 animate-[message-in_0.2s_ease-out]" role="alert">
        <div
          className={`max-w-[88%] rounded-xl px-4 py-3 border-l-2 ${
            light
              ? 'bg-red-50 border-red-400 text-red-700'
              : 'bg-red-950/40 border-red-500 text-red-200'
          }`}
        >
          <div className="flex items-start gap-2">
            <svg className="w-4 h-4 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <div className="min-w-0">
              <div className="text-xs font-semibold mb-1">{errorInfo.title}</div>
              <div className="text-xs leading-relaxed opacity-90 break-words
                [&>p]:my-1 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0
                [&>ul]:mt-1 [&>ul]:mb-0 [&>ul]:pl-4 [&>ul]:list-disc
                [&_li]:mb-0.5 [&_strong]:font-semibold"
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{r(errorInfo.detail)}</ReactMarkdown>
              </div>
              <div className={`flex items-center gap-2 mt-2 ${onRetry ? 'flex-wrap' : ''}`}>
                <span className={`text-[11px] ${light ? 'text-red-600/80' : 'text-red-300/80'}`}>
                  {errorInfo.retryHint}
                </span>
                {onRetry && (
                  <button
                    onClick={onRetry}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
                      light
                        ? 'bg-red-100 hover:bg-red-200 text-red-700'
                        : 'bg-red-500/20 hover:bg-red-500/30 text-red-200'
                    }`}
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="23 4 23 10 17 10" />
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                    Retry
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className={`text-[9px] mt-2 text-right ${light ? 'text-red-400' : 'text-red-300/60'}`}>
            {formatRelativeTime(timestamp)}
          </div>
        </div>
      </div>
    );
  }

  const cleanContent = isUser ? content : stripActionMarkers(content);
  const shouldCollapse = !isUser && !isStreaming && cleanContent.length > COLLAPSE_THRESHOLD;
  const rawDisplay = shouldCollapse && !expanded
    ? cleanContent.slice(0, TRUNCATE_AT) + '...'
    : cleanContent;
  // Display-only redaction. The chat history sent to Bedrock (via store.chatMessages)
  // and the markdown copied via Copy/copyToClipboard are intentionally untouched
  // — the assistant must still see real IDs to be useful.
  const displayContent = r(rawDisplay);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3 animate-[message-in_0.2s_ease-out]`}>
      <div
        className={`max-w-[88%] rounded-xl px-4 py-3 ${
          isUser
            ? 'bg-blue-600 text-white shadow-sm'
            : light
              ? 'bg-white text-gray-800 border-l-2 border-violet-500 shadow-sm'
              : 'bg-slate-700/80 text-slate-200 border-l-2 border-violet-500 shadow-md shadow-black/10'
        }`}
      >
        <div className={`text-xs leading-relaxed prose prose-xs max-w-none
          [&>p]:my-1.5 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0
          [&>ul]:mt-1 [&>ul]:mb-2 [&>ol]:mt-1 [&>ol]:mb-2
          [&_table]:text-xs [&_table]:border-collapse [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:px-2 [&_td]:py-1
          [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:pb-1 [&_h2]:border-b ${light ? '[&_h2]:border-gray-300/50' : '[&_h2]:border-slate-500/30'}
          [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:mt-2.5 [&_h3]:mb-1 [&_h3]:pb-0.5 [&_h3]:border-b ${light ? '[&_h3]:border-gray-300/30' : '[&_h3]:border-slate-500/20'}
          [&_h4]:text-xs [&_h4]:font-semibold [&_h4]:mt-2 [&_h4]:mb-0.5
          [&_li]:ml-3 [&_li]:mb-0.5
          [&_strong]:font-semibold
          [&_hr]:my-3 [&_hr]:border-0 [&_hr]:h-px ${light ? '[&_hr]:bg-gray-300/50' : '[&_hr]:bg-slate-500/30'}
          [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_blockquote]:my-2 [&_blockquote]:italic [&_blockquote]:opacity-80
          ${light ? '[&_th]:border-gray-300 [&_td]:border-gray-300 [&_blockquote]:border-gray-400' : '[&_th]:border-slate-600 [&_td]:border-slate-600 [&_blockquote]:border-slate-500 prose-invert'}`}
        >
          {/* SECURITY: Do not add rehype-raw without rehype-sanitize — it would enable XSS via AI responses */}
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code: ({ className: cn, children: ch, ...rest }) => {
                const isBlock = cn?.startsWith('language-');
                if (isBlock) {
                  return <CodeBlock className={cn} {...rest}>{ch}</CodeBlock>;
                }
                return (
                  <code className={`px-1 py-0.5 rounded text-[11px] ${light ? 'bg-gray-300/50' : 'bg-slate-600/50'}`} style={{ fontFamily: "'JetBrains Mono', monospace" }} {...rest}>
                    {ch}
                  </code>
                );
              },
              pre: ({ children }) => <>{children}</>,
            }}
          >
            {displayContent}
          </ReactMarkdown>
          {shouldCollapse && (
            <button
              onClick={() => setExpanded(!expanded)}
              className={`text-[10px] font-medium mt-1 cursor-pointer ${light ? 'text-blue-600 hover:text-blue-700' : 'text-blue-400 hover:text-blue-300'}`}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
        {!isUser && !isStreaming && <ChatActions content={content} />}
        {!isUser && !isStreaming && !isFirstMessage && (
          <div className="flex items-center justify-between mt-1.5">
            <button
              onClick={handleCopyMessage}
              className={`flex items-center gap-1 text-[10px] transition-colors cursor-pointer ${
                copied
                  ? (light ? 'text-emerald-600' : 'text-emerald-400')
                  : light ? 'text-gray-400 hover:text-gray-600' : 'text-slate-500 hover:text-slate-300'
              }`}
              title="Copy response as markdown"
            >
              {copied ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              )}
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <span className={`text-[9px] ${light ? 'text-gray-400' : 'text-slate-400'}`}>
              {formatRelativeTime(timestamp)}
            </span>
          </div>
        )}
        {(isUser || isStreaming || isFirstMessage) && (
          <div className={`text-[9px] mt-1 text-right ${
            isUser ? 'text-blue-200' : light ? 'text-gray-400' : 'text-slate-400'
          }`}>
            {formatRelativeTime(timestamp)}
          </div>
        )}
      </div>
    </div>
  );
});
