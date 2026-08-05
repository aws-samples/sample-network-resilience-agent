import { useState } from 'react';
import { useTopologyStore } from '../store/topology-store';
import { useIsLight } from '../hooks/useTheme';
import type { MockScenario } from '../utils/shared';

interface ParsedAction {
  id: string;
  label: string;
}

const ACTION_RE = /\[ACTION:([^\]|]+)\|([^\]]+)\]/g;

function parseActions(content: string): ParsedAction[] {
  const actions: ParsedAction[] = [];
  let match;
  while ((match = ACTION_RE.exec(content)) !== null) {
    actions.push({ id: match[1], label: match[2] });
  }
  return actions;
}

// Lives here rather than in its own module because it shares ACTION_RE with
// parseActions below; the cost is that this file opts out of fast refresh.
// eslint-disable-next-line react-refresh/only-export-components
export function stripActionMarkers(content: string): string {
  return content.replace(ACTION_RE, '').trimEnd();
}

export function ChatActions({ content }: { content: string }) {
  const light = useIsLight();
  const [clicked, setClicked] = useState<Set<string>>(new Set());
  const actions = parseActions(content);

  if (actions.length === 0) return null;

  const dispatch = (actionId: string) => {
    const store = useTopologyStore.getState();
    if (actionId === 'switch_to_recommended') store.setViewMode('recommended');
    else if (actionId === 'switch_to_current') store.setViewMode('current');
    else if (actionId === 'start_simulation') store.setIsSimulating(true);
    else if (actionId === 'stop_simulation') store.setIsSimulating(false);
    else if (actionId.startsWith('show_scenario:')) {
      const scenario = actionId.split(':')[1] as MockScenario;
      store.setMockScenario(scenario);
    }
    setClicked((prev) => new Set(prev).add(actionId));
  };

  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {actions.map((a) => {
        const done = clicked.has(a.id);
        return (
          <button
            key={a.id}
            onClick={() => dispatch(a.id)}
            disabled={done}
            className={`text-[10px] font-medium px-2.5 py-1 rounded-full border transition-colors cursor-pointer ${
              done
                ? (light ? 'bg-emerald-50 border-emerald-300 text-emerald-600' : 'bg-emerald-900/30 border-emerald-700 text-emerald-400')
                : light
                  ? 'bg-blue-50 border-blue-200 text-blue-600 hover:bg-blue-100'
                  : 'bg-blue-900/30 border-blue-700 text-blue-300 hover:bg-blue-900/50'
            }`}
          >
            {done ? '\u2713 ' : ''}{a.label}
          </button>
        );
      })}
    </div>
  );
}
