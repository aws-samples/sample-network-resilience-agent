import { useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { TopBar } from './components/TopBar';
import { FlowCanvas } from './components/FlowCanvas';
import { ChatPanel } from './components/ChatPanel';
import { ResiliencyScoreCard } from './components/ResiliencyScoreCard';
import { GuidedTour, type GuidedTourHandle } from './components/GuidedTour';
import { EmptyStateBanner } from './components/EmptyStateBanner';
import { WelcomeBanner } from './components/WelcomeBanner';
import { useTopology } from './hooks/useTopology';
import { useTopologyStore } from './store/topology-store';
import { useIsLight } from './hooks/useTheme';
import { COLORS } from './utils/colors';
import { useSessionTimeout } from './hooks/useSessionTimeout';
import { useUnloadCleaner } from './hooks/useUnloadCleaner';

// Divider bounds as a percentage of the window width — shared by the drag
// clamp, the arrow-key step, and the separator's aria-value range.
const MIN_DIVIDER_PCT = 30;
const MAX_DIVIDER_PCT = 85;
const DIVIDER_KEY_STEP = 2;

export default function App() {
  const { loadTopology } = useTopology();
  const isLoading = useTopologyStore((s) => s.isLoading);
  const error = useTopologyStore((s) => s.error);
  const currentNodes = useTopologyStore((s) => s.currentNodes);
  const credentials = useTopologyStore((s) => s.credentials);
  const setCredentials = useTopologyStore((s) => s.setCredentials);
  const clearChat = useTopologyStore((s) => s.clearChat);
  const resetTopology = useTopologyStore((s) => s.resetTopology);
  const isLocked = useTopologyStore((s) => s.isLocked);
  const importedSnapshot = useTopologyStore((s) => s.importedSnapshot);
  const clearImportedSnapshot = useTopologyStore((s) => s.clearImportedSnapshot);
  const light = useIsLight();
  const [dividerX, setDividerX] = useState(75);
  const [chatOpen, setChatOpen] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  // Reset each time the user signs out so the welcome banner reappears after
  // sign-out even if it was dismissed during the prior signed-out session.
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const isDragging = useRef(false);
  const rafId = useRef(0);
  const tourRef = useRef<GuidedTourHandle>(null);

  const { isWarning, secondsLeft } = useSessionTimeout(!!credentials, () => {
    setCredentials(null);
    clearChat();
    setSessionExpired(true);
    // Reset to the blank cold-start canvas rather than reloading the mock
    // demo — an idle timeout should leave the SA looking at an empty canvas
    // behind the reconnect prompt, not silently swap in demo data.
    resetTopology();
  });

  useUnloadCleaner(!!credentials, clearChat);

  // Adjust the sign-out banners the moment the credentials change, during
  // render rather than in an effect — an effect would paint one frame with the
  // stale "session expired" notice still up after a successful reconnect.
  const [prevCredentials, setPrevCredentials] = useState(credentials);
  if (credentials !== prevCredentials) {
    setPrevCredentials(credentials);
    if (credentials) {
      setSessionExpired(false);
      // Clear the dismissed flag while signed in so next sign-out shows the
      // banner again. The banner itself is gated on `!credentials`, so this
      // state is invisible until the credentials go away.
      setWelcomeDismissed(false);
    }
  }

  // Cold start renders an empty canvas behind the welcome banner — the user
  // must pick "Connect AWS" or "Use demo data" before any topology loads.
  // Sign-out and session timeout call resetTopology() to return to that same
  // blank state behind the reconnect prompt, rather than silently reloading
  // the mock demo scenario.

  const handleMouseDown = () => {
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging.current) return;
    cancelAnimationFrame(rafId.current);
    rafId.current = requestAnimationFrame(() => {
      const pct = (e.clientX / window.innerWidth) * 100;
      setDividerX(Math.max(MIN_DIVIDER_PCT, Math.min(MAX_DIVIDER_PCT, pct)));
    });
  };

  const handleDividerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' ? -DIVIDER_KEY_STEP : e.key === 'ArrowRight' ? DIVIDER_KEY_STEP : 0;
    if (!step) return;
    e.preventDefault();
    setDividerX((v) => Math.max(MIN_DIVIDER_PCT, Math.min(MAX_DIVIDER_PCT, v + step)));
  };

  const handleMouseUp = () => {
    isDragging.current = false;
    cancelAnimationFrame(rafId.current);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      cancelAnimationFrame(rafId.current);
    };
  }, []);

  return (
    <ReactFlowProvider>
      <div
        data-theme={light ? 'light' : 'dark'}
        data-locked={isLocked ? 'true' : 'false'}
        className={`flex flex-col h-screen ${light ? 'text-slate-800' : 'bg-slate-900 text-slate-200'}`}
        style={light ? { backgroundColor: COLORS.light.appBg } : undefined}
      >
        <TopBar
          onRefresh={loadTopology}
          onToggleChat={() => setChatOpen((v) => !v)}
          chatOpen={chatOpen}
          onStartTour={() => tourRef.current?.start()}
        />

        {sessionExpired && (
          <div className={`px-4 py-2 text-xs text-center border-b ${light ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-amber-900/20 border-amber-700/40 text-amber-300'}`}>
            Session expired after 15 minutes of inactivity. Please reconnect to AWS.
          </div>
        )}

        {isWarning && secondsLeft !== null && (
          <div className={`px-4 py-2 text-xs text-center border-b ${light ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-amber-900/20 border-amber-700/40 text-amber-300'}`}>
            Session expires in <strong>{secondsLeft}s</strong> due to inactivity. Move your mouse or press a key to stay connected.
          </div>
        )}

        {error && currentNodes.length > 0 && (
          <div className={`px-4 py-2 border-b text-xs ${light ? 'bg-red-100 border-red-300 text-red-700' : 'bg-red-900/50 border-red-700 text-red-300'}`}>
            {error}
          </div>
        )}

        {importedSnapshot && (
          <div
            className={`flex items-center justify-center gap-2.5 px-4 py-2 text-[11px] leading-relaxed border-b ${
              light
                ? 'bg-indigo-50 border-indigo-200 text-indigo-800'
                : 'bg-indigo-900/25 border-indigo-700/40 text-indigo-200'
            }`}
            role="status"
          >
            <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span>
              <strong className="font-semibold">Viewing imported snapshot</strong>
              {' '}exported {new Date(importedSnapshot.exportedAt).toLocaleString()}
              {importedSnapshot.appVersion && (
                <span className={light ? 'text-indigo-600/80' : 'text-indigo-300/80'}>
                  {' · '}app v{importedSnapshot.appVersion}
                </span>
              )}
              {importedSnapshot.redactedView && (
                <span className={`ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                  light ? 'bg-indigo-100 text-indigo-700' : 'bg-indigo-500/20 text-indigo-200'
                }`}>
                  <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  SANITIZED
                </span>
              )}
              {importedSnapshot.customerNote && (
                <span className={`ml-2 italic ${light ? 'text-indigo-700/80' : 'text-indigo-200/80'}`}>
                  — {importedSnapshot.customerNote}
                </span>
              )}
            </span>
            <button
              onClick={() => {
                // Clear imported state first, then trigger a normal topology
                // load — this restores either the SA's live AWS view (if
                // credentials are present) or the default mock scenario.
                clearImportedSnapshot();
                loadTopology();
              }}
              className={`ml-1 px-2 py-0.5 text-[10px] font-semibold rounded-md transition-colors ${
                light
                  ? 'text-indigo-700 hover:bg-indigo-100 border border-indigo-300'
                  : 'text-indigo-200 hover:bg-indigo-500/20 border border-indigo-400/30'
              }`}
              title="Exit imported snapshot view"
            >
              Exit
            </button>
          </div>
        )}

        <div className="flex flex-1 overflow-hidden relative">
          {/* Visualizer */}
          <div className="relative" style={{ width: chatOpen ? `${dividerX}%` : '100%' }}>
            {isLoading && (
              <div className={`absolute inset-0 z-20 flex items-center justify-center ${light ? 'bg-gray-200/80' : 'bg-slate-900/80'}`}>
                <div className="flex flex-col items-center gap-2">
                  <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  <span className={`text-xs ${light ? 'text-slate-500' : 'text-slate-400'}`}>Connecting to AWS — scanning enabled regions...</span>
                </div>
              </div>
            )}
            {error && !isLoading && currentNodes.length === 0 && (
              <div className={`absolute inset-0 z-20 flex items-center justify-center ${light ? 'bg-gray-50' : 'bg-slate-900/95'}`}>
                <div className={`flex flex-col items-center gap-4 max-w-md text-center p-8 rounded-xl border ${light ? 'bg-gray-100 border-gray-300 shadow-lg' : 'bg-slate-800 border-slate-700'}`}>
                  <div className={`w-12 h-12 rounded-full flex items-center justify-center ${light ? 'bg-red-100' : 'bg-red-900/40'}`}>
                    <svg className="w-6 h-6 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  </div>
                  <div>
                    <h3 className={`text-sm font-semibold mb-1 ${light ? 'text-gray-800' : 'text-white'}`}>Connection Failed</h3>
                    <p className={`text-xs leading-relaxed ${light ? 'text-gray-500' : 'text-slate-400'}`}>{error}</p>
                  </div>
                  <div className="flex gap-2 w-full">
                    <button
                      onClick={loadTopology}
                      className="flex-1 px-3 py-2 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors"
                    >
                      Retry
                    </button>
                    <button
                      onClick={() => {
                        const store = useTopologyStore.getState();
                        store.setCredentials(null);
                        store.setError(null);
                        loadTopology();
                      }}
                      className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg transition-colors ${light ? 'bg-gray-200 text-gray-700 hover:bg-gray-300' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
                    >
                      Use Demo Data
                    </button>
                  </div>
                </div>
              </div>
            )}
            <div data-tour="topology" className="absolute inset-0">
              <FlowCanvas />
            </div>
            <EmptyStateBanner welcomeDismissed={welcomeDismissed} />
            <WelcomeBanner
              dismissed={welcomeDismissed}
              onDismiss={() => setWelcomeDismissed(true)}
              onUseDemo={loadTopology}
            />
            <ResiliencyScoreCard />
          </div>

          {/* Divider + Chat */}
          {chatOpen && (
            <>
              {/* WAI-ARIA window-splitter pattern, same as the chat input's
                  resize handle: a focusable `separator` carrying aria-valuenow
                  and resized with the arrow keys. jsx-a11y models every
                  separator as non-interactive, so both rules below are false
                  positives here — dropping tabIndex would remove the only
                  keyboard path to resize. */}
              {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize chat panel (drag, or use arrow keys)"
                aria-valuenow={Math.round(dividerX)}
                aria-valuemin={MIN_DIVIDER_PCT}
                aria-valuemax={MAX_DIVIDER_PCT}
                tabIndex={0}
                className={`w-1 hover:bg-blue-500 cursor-col-resize transition-colors flex-shrink-0 z-10 ${light ? 'bg-gray-300' : 'bg-slate-700'}`}
                onMouseDown={handleMouseDown}
                onKeyDown={handleDividerKeyDown}
              />
              {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
              <div className="flex-1 min-w-0" style={{ width: `${100 - dividerX}%` }}>
                <ChatPanel />
              </div>
            </>
          )}
        </div>

        <GuidedTour ref={tourRef} />
      </div>
    </ReactFlowProvider>
  );
}
