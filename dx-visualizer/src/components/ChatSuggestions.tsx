import { useIsLight } from '../hooks/useTheme';

interface Suggestion {
  title: string;
  subtitle: string;
  prompt: string;
}

const SUGGESTIONS: Suggestion[] = [
  {
    title: 'Improve resiliency',
    subtitle: 'Recommend changes to reach the next tier',
    prompt: 'How can I improve my resiliency?',
  },
  {
    title: 'Explain my topology',
    subtitle: 'Walk through what is deployed right now',
    prompt: 'What does my current topology look like?',
  },
  {
    title: 'Estimate upgrade cost',
    subtitle: 'Ballpark the price to increase SLA',
    prompt: 'Estimate the cost to upgrade resiliency',
  },
  {
    title: 'Best practice gaps',
    subtitle: 'Flag missing operational controls',
    prompt: 'What best practices am I missing?',
  },
];

interface Props {
  onSelect: (prompt: string) => void;
}

export function ChatSuggestions({ onSelect }: Props) {
  const light = useIsLight();

  return (
    <div className="px-1 mt-2">
      <p className={`text-[10px] font-medium uppercase tracking-wider mb-2.5 px-1 ${light ? 'text-gray-400' : 'text-slate-500'}`}>
        Try asking
      </p>
      <div className="grid grid-cols-2 gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.prompt}
            onClick={() => onSelect(s.prompt)}
            className={`group flex flex-col text-left rounded-lg border p-2.5 transition-all duration-150 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
              light
                ? 'border-gray-200/80 bg-white hover:border-gray-300 hover:shadow-sm'
                : 'border-slate-700/60 bg-slate-800/40 hover:border-slate-600 hover:bg-slate-800/70'
            }`}
          >
            <span className={`text-[11px] font-semibold leading-tight ${light ? 'text-gray-800 group-hover:text-gray-900' : 'text-slate-100'}`}>
              {s.title}
            </span>
            <span className={`text-[10px] leading-snug mt-0.5 ${light ? 'text-gray-500' : 'text-slate-400'}`}>
              {s.subtitle}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
