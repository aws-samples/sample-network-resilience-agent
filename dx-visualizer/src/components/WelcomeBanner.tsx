import { useRef } from 'react';
import { useTopologyStore } from '../store/topology-store';
import { useIsLight } from '../hooks/useTheme';
import { useImportSnapshot } from '../hooks/useImportSnapshot';

// Signed-out welcome card. Invites the user to either connect live AWS
// credentials, import a previously-exported snapshot, or browse the mock
// scenarios. Rendered as a non-modal overlay over the canvas. On cold start
// there is no topology behind it (the canvas stays blank until the user
// chooses), so the dismiss affordance only shows once a demo, live, or
// snapshot topology has actually been loaded.
export function WelcomeBanner({ dismissed, onDismiss, onUseDemo }: { dismissed: boolean; onDismiss: () => void; onUseDemo: () => void }) {
  const credentials = useTopologyStore((s) => s.credentials);
  const topologyData = useTopologyStore((s) => s.topologyData);
  const isLoading = useTopologyStore((s) => s.isLoading);
  const error = useTopologyStore((s) => s.error);
  const setCredentialsModalOpen = useTopologyStore((s) => s.setCredentialsModalOpen);
  const importSnapshot = useImportSnapshot();
  const importInputRef = useRef<HTMLInputElement>(null);
  const light = useIsLight();

  if (isLoading || error) return null;
  if (credentials) return null;
  if (dismissed) return null;

  // Pre-choice (no topology yet) we hide the X close so the user is nudged
  // to actually pick a path; once a topology is loaded the X reappears.
  const showDismiss = topologyData != null;

  return (
    <div className="absolute inset-x-0 top-6 z-10 flex items-start justify-center px-6 pointer-events-none">
      <div
        className={`pointer-events-auto relative max-w-md w-full rounded-xl border p-5 text-center shadow-xl ${
          light
            ? 'bg-white/95 border-slate-200/80 backdrop-blur-sm shadow-slate-300/40'
            : 'bg-slate-800/95 border-slate-700 backdrop-blur-sm shadow-black/30'
        }`}
      >
        {showDismiss && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss welcome banner"
            className={`absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded transition-colors ${
              light ? 'text-slate-400 hover:text-slate-600 hover:bg-slate-100' : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.06]'
            }`}
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
        <div className={`w-9 h-9 mx-auto rounded-full flex items-center justify-center mb-2.5 ${light ? 'bg-blue-100' : 'bg-blue-500/15'}`}>
          <svg
            className={`w-4.5 h-4.5 ${light ? 'text-blue-600' : 'text-blue-400'}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <polyline points="10 17 15 12 10 7" />
            <line x1="15" y1="12" x2="3" y2="12" />
          </svg>
        </div>
        <h2 className={`text-sm font-semibold mb-1.5 ${light ? 'text-slate-800' : 'text-white'}`}>
          Connect to AWS to begin
        </h2>
        <p className={`text-xs leading-relaxed ${light ? 'text-slate-500' : 'text-slate-400'}`}>
          Sign in with Identity Center or an access key to discover your live Direct Connect topology,
          import a previously-exported snapshot, or keep exploring the demo scenario.
        </p>
        <button
          onClick={() => setCredentialsModalOpen(true)}
          className={`w-full px-3 py-2 mt-4 text-xs font-semibold rounded-lg transition-colors ${
            light ? 'bg-blue-500 text-white hover:bg-blue-600' : 'bg-blue-600 text-white hover:bg-blue-500'
          }`}
        >
          Connect AWS
        </button>
        <div className="flex gap-2 mt-2">
          <button
            onClick={() => importInputRef.current?.click()}
            className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
              light ? 'bg-slate-100 text-slate-700 hover:bg-slate-200' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            Import snapshot
          </button>
          <button
            onClick={() => {
              // On cold start there's no topology yet — kick off the mock
              // load so the canvas actually has something to dismiss into.
              if (!topologyData) onUseDemo();
              onDismiss();
            }}
            className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
              light ? 'bg-slate-100 text-slate-700 hover:bg-slate-200' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            Use demo data
          </button>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            // Reset value so picking the same file twice still fires onChange.
            e.target.value = '';
            if (!file) return;
            await importSnapshot(file);
            // A successful import sets `importedSnapshot` in the store, which
            // means a topology now exists behind the banner — dismiss so the
            // user sees the loaded snapshot. If validation failed the store's
            // error state will surface a toast and the banner stays visible.
            if (useTopologyStore.getState().importedSnapshot) onDismiss();
          }}
        />
      </div>
    </div>
  );
}
