import { useState, useMemo, useRef, useEffect } from 'react';
import { ViewToggle } from './ViewToggle';
import { CredentialsModal } from './CredentialsModal';
import { FullExportConfirmModal } from './FullExportConfirmModal';
import { MaintenanceCalendar } from './MaintenanceCalendar';
import { useTopologyStore } from '../store/topology-store';
import { useIsLight } from '../hooks/useTheme';
import { useExportImage } from '../hooks/useExportImage';
import { useExportSnapshot } from '../hooks/useExportSnapshot';
import { useImportSnapshot } from '../hooks/useImportSnapshot';
import { config } from '../utils/config';
import { redact } from '../utils/redact';

export function TopBar({ onRefresh, onToggleChat, chatOpen, onStartTour }: { onRefresh: () => void; onToggleChat: () => void; chatOpen: boolean; onStartTour: () => void }) {
  const showCredentials = useTopologyStore((s) => s.credentialsModalOpen);
  const setShowCredentials = useTopologyStore((s) => s.setCredentialsModalOpen);
  const [dismissedStatusDisclaimer, setDismissedStatusDisclaimer] = useState(false);
  const useMock = useTopologyStore((s) => s.useMock);
  const mockScenario = useTopologyStore((s) => s.mockScenario);
  const setMockScenario = useTopologyStore((s) => s.setMockScenario);
  const theme = useTopologyStore((s) => s.theme);
  const toggleTheme = useTopologyStore((s) => s.toggleTheme);
  const showLiveStatus = useTopologyStore((s) => s.showLiveStatus);
  const toggleLiveStatus = useTopologyStore((s) => s.toggleLiveStatus);
  const redactMode = useTopologyStore((s) => s.redactMode);
  const toggleRedactMode = useTopologyStore((s) => s.toggleRedactMode);
  const showUtilization = useTopologyStore((s) => s.showUtilization);
  const setShowUtilization = useTopologyStore((s) => s.setShowUtilization);
  const utilizationWindowDays = useTopologyStore((s) => s.utilizationWindowDays);
  const utilizationLoading = useTopologyStore((s) => s.utilizationLoading);
  const utilizationError = useTopologyStore((s) => s.utilizationError);
  const loadUtilization = useTopologyStore((s) => s.loadUtilization);
  const viewMode = useTopologyStore((s) => s.viewMode);
  const setViewMode = useTopologyStore((s) => s.setViewMode);
  const isSimulating = useTopologyStore((s) => s.isSimulating);
  const setIsSimulating = useTopologyStore((s) => s.setIsSimulating);
  const failedNodeIds = useTopologyStore((s) => s.failedNodeIds);
  const failedEdgeIds = useTopologyStore((s) => s.failedEdgeIds);
  const clearFailures = useTopologyStore((s) => s.clearFailures);
  const currentEdges = useTopologyStore((s) => s.currentEdges);
  const credentials = useTopologyStore((s) => s.credentials);
  const setCredentials = useTopologyStore((s) => s.setCredentials);
  const clearChat = useTopologyStore((s) => s.clearChat);
  const isLoading = useTopologyStore((s) => s.isLoading);
  const importedSnapshot = useTopologyStore((s) => s.importedSnapshot);
  const topologyData = useTopologyStore((s) => s.topologyData);
  const light = useIsLight();
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [connectMenuOpen, setConnectMenuOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [windowOpen, setWindowOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showFullExportConfirm, setShowFullExportConfirm] = useState(false);
  const scenarioRef = useRef<HTMLDivElement>(null);
  const connectMenuRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const exportImage = useExportImage();
  const exportSnapshot = useExportSnapshot();
  const importSnapshot = useImportSnapshot();
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (scenarioRef.current && !scenarioRef.current.contains(e.target as Node)) setScenarioOpen(false);
      if (connectMenuRef.current && !connectMenuRef.current.contains(e.target as Node)) setConnectMenuOpen(false);
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) setOverflowOpen(false);
      if (windowRef.current && !windowRef.current.contains(e.target as Node)) setWindowOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setScenarioOpen(false);
        setConnectMenuOpen(false);
        setOverflowOpen(false);
        setWindowOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onEsc);
    };
  }, []);

  // Reset the dismissed-disclaimer flag whenever the imported snapshot changes
  // (entering / exiting imported mode, or swapping one imported file for
  // another). The disclaimer copy is different in imported mode and is
  // load-bearing — the SA needs to see the "frozen at export time" warning
  // even if they previously dismissed the live-mode disclaimer.
  useEffect(() => {
    setDismissedStatusDisclaimer(false);
  }, [importedSnapshot]);

  const handleExportImage = async () => {
    setOverflowOpen(false);
    setIsExporting(true);
    try {
      await exportImage();
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportSanitized = async () => {
    setOverflowOpen(false);
    setIsExporting(true);
    try {
      await exportSnapshot({ sanitize: true });
    } catch (err) {
      console.error('Snapshot export failed:', err);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportFull = () => {
    setOverflowOpen(false);
    // Defer the actual export to the confirmation modal — the file will
    // contain real customer identifiers, so a styled in-app warning beats
    // the native window.confirm() dialog.
    setShowFullExportConfirm(true);
  };

  const handleFullExportConfirmed = async () => {
    setShowFullExportConfirm(false);
    setIsExporting(true);
    try {
      await exportSnapshot({ sanitize: false });
    } catch (err) {
      console.error('Snapshot export failed:', err);
    } finally {
      setIsExporting(false);
    }
  };

  const handleImportClick = () => {
    setOverflowOpen(false);
    importInputRef.current?.click();
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input value so picking the same file twice in a row still
    // fires onChange — browsers suppress duplicate selections otherwise.
    e.target.value = '';
    if (!file) return;
    await importSnapshot(file);
  };

  const scenarioOptions = [
    { value: 'noResiliency', label: 'No Resiliency' },
    { value: 'devTest', label: 'Development & Testing' },
    { value: 'high', label: 'High Resiliency' },
    { value: 'maximum', label: 'Maximum Resiliency' },
    { value: 'crossAccount', label: 'Cross-Account' },
  ] as const;

  const hasFailures = failedNodeIds.size > 0 || failedEdgeIds.size > 0;
  const isConnected = !!credentials && !useMock;

  const impactSummary = useMemo(() => {
    if (!isSimulating || !hasFailures) return null;
    const totalEdges = currentEdges.filter((e) => !e.data?.isRecommended).length;
    let downEdges = 0;
    for (const e of currentEdges) {
      if (e.data?.isRecommended) continue;
      if (failedEdgeIds.has(e.id) || failedNodeIds.has(e.source) || failedNodeIds.has(e.target)) {
        downEdges++;
      }
    }
    const upEdges = totalEdges - downEdges;
    return { totalEdges, downEdges, upEdges, failedNodes: failedNodeIds.size, failedLinks: failedEdgeIds.size };
  }, [isSimulating, hasFailures, failedNodeIds, failedEdgeIds, currentEdges]);

  const iconBtn = (active = false) =>
    `flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${
      light ? 'focus-visible:ring-offset-white' : 'focus-visible:ring-offset-slate-900'
    } ${
      active
        ? light ? 'bg-gray-200/80 text-gray-700' : 'bg-slate-700 text-slate-200'
        : light ? 'text-gray-500 hover:bg-gray-100 hover:text-gray-700' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
    }`;

  return (
    <>
      <div
        className={`flex items-center justify-between px-4 h-11 border-b transition-colors duration-300 ${
          isSimulating
            ? light
              ? 'bg-red-50/70 border-red-200/70'
              : 'bg-gradient-to-r from-red-950/30 to-slate-900 border-red-800/30'
            : light
              ? 'bg-white border-slate-200'
              : 'bg-gradient-to-r from-slate-900 to-slate-900/95 border-slate-700/80'
        }`}
        style={
          isSimulating
            ? { boxShadow: light ? '0 1px 8px rgba(239,68,68,0.08)' : '0 1px 8px rgba(239,68,68,0.12)' }
            : light
              ? { boxShadow: '0 1px 2px rgba(15,23,42,0.04)' }
              : undefined
        }
      >
        {/* Left: Brand + scenario */}
        <div className="flex items-center gap-3 min-w-0">
          <h1 className={`text-[13px] font-semibold tracking-tight truncate ${light ? 'text-gray-800' : 'text-white/90'}`}>
            {config.appTitle}
          </h1>
          {useMock && topologyData && !importedSnapshot && (
            <div ref={scenarioRef} className="relative">
              <button
                onClick={() => setScenarioOpen(!scenarioOpen)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                  light
                    ? 'bg-gray-100 text-gray-700 hover:bg-gray-200/80'
                    : 'bg-white/[0.08] text-slate-300 hover:bg-white/[0.12]'
                }`}
              >
                <span className={`${light ? 'text-gray-400' : 'text-slate-500'} mr-0.5`}>Scenario:</span>
                {scenarioOptions.find((o) => o.value === mockScenario)?.label}
                <svg className={`w-3 h-3 opacity-50 transition-transform ${scenarioOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {scenarioOpen && (
                <div style={{ fontFamily: 'inherit' }} className={`absolute top-full left-0 mt-1 py-1 rounded-lg shadow-lg border z-50 min-w-[160px] ${
                  light
                    ? 'bg-white border-gray-200 shadow-gray-200/50'
                    : 'bg-slate-800 border-slate-700 shadow-black/40'
                }`}>
                  {scenarioOptions.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => {
                        setMockScenario(opt.value as typeof mockScenario);
                        setScenarioOpen(false);
                        onRefresh();
                      }}
                      className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${
                        mockScenario === opt.value
                          ? light
                            ? 'bg-blue-50 text-blue-600 font-semibold'
                            : 'bg-blue-500/15 text-blue-400 font-semibold'
                          : light
                            ? 'text-gray-700 hover:bg-gray-50'
                            : 'text-slate-300 hover:bg-white/[0.06]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Center: Main controls — hidden on cold start until the user picks
            Connect AWS or Use demo data and a topology actually loads. */}
        <div className="flex items-center gap-2" style={{ visibility: topologyData ? 'visible' : 'hidden' }}>
          {/* Overlays: Live + Utilization + Recommendation */}
          <div data-tour="overlays" className={`flex items-center gap-0.5 rounded-lg p-0.5 ${light ? 'bg-gray-100/80' : 'bg-white/[0.04]'}`}>
            <button
              onClick={() => { toggleLiveStatus(); setDismissedStatusDisclaimer(false); }}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md transition-all duration-150 ${
                showLiveStatus
                  ? (light ? 'bg-emerald-100 text-emerald-700 shadow-sm' : 'bg-emerald-500/15 text-emerald-300')
                  : light ? 'text-gray-600 hover:text-gray-800 hover:bg-white' : 'text-slate-300 hover:text-slate-100 hover:bg-white/5'
              }`}
              title={
                importedSnapshot
                  ? showLiveStatus
                    ? `Hide snapshot status (frozen at ${new Date(importedSnapshot.exportedAt).toLocaleString()})`
                    : `Show snapshot status (frozen at ${new Date(importedSnapshot.exportedAt).toLocaleString()})`
                  : showLiveStatus ? 'Hide live status' : 'Show live status'
              }
              aria-label={showLiveStatus ? 'Hide live status overlay' : 'Show live status overlay'}
              aria-pressed={showLiveStatus}
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
              {importedSnapshot ? 'Snapshot' : 'Live'}
            </button>
            <button
              onClick={() => {
                const next = !showUtilization;
                setShowUtilization(next);
                if (next) loadUtilization(utilizationWindowDays);
              }}
              disabled={utilizationLoading}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md transition-all duration-150 disabled:cursor-wait ${
                showUtilization
                  ? (light ? 'bg-emerald-100 text-emerald-700 shadow-sm' : 'bg-emerald-500/15 text-emerald-300')
                  : light ? 'text-gray-600 hover:text-gray-800 hover:bg-white' : 'text-slate-300 hover:text-slate-100 hover:bg-white/5'
              }`}
              title={
                utilizationError
                  ? `Utilization error: ${utilizationError}`
                  : showUtilization ? 'Hide CloudWatch utilization' : 'Show CloudWatch utilization (peak over window)'
              }
              aria-pressed={showUtilization}
            >
              {utilizationLoading ? (
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="3" y1="20" x2="3" y2="10" />
                  <line x1="9" y1="20" x2="9" y2="4" />
                  <line x1="15" y1="20" x2="15" y2="14" />
                  <line x1="21" y1="20" x2="21" y2="8" />
                </svg>
              )}
              Utilization
            </button>
            {showUtilization && (
              <div ref={windowRef} className="relative">
                <button
                  onClick={() => setWindowOpen(!windowOpen)}
                  disabled={utilizationLoading}
                  className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md transition-colors disabled:cursor-wait ${
                    light ? 'bg-gray-100 text-gray-700 hover:bg-gray-200/80' : 'bg-white/[0.08] text-slate-300 hover:bg-white/[0.12]'
                  }`}
                  title="Lookback window"
                  aria-haspopup="menu"
                  aria-expanded={windowOpen}
                >
                  {utilizationWindowDays}d
                  <svg className={`w-3 h-3 opacity-50 transition-transform ${windowOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {windowOpen && (
                  <div role="menu" className={`absolute top-full left-0 mt-1 py-1 rounded-lg shadow-lg border z-50 min-w-[110px] ${
                    light ? 'bg-white border-gray-200 shadow-gray-200/50' : 'bg-slate-800 border-slate-700 shadow-black/40'
                  }`}>
                    {([30, 60, 90] as const).map((d) => (
                      <button
                        key={d}
                        role="menuitem"
                        onClick={() => {
                          setWindowOpen(false);
                          loadUtilization(d);
                        }}
                        className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${
                          utilizationWindowDays === d
                            ? light ? 'bg-blue-50 text-blue-600 font-semibold' : 'bg-blue-500/15 text-blue-400 font-semibold'
                            : light ? 'text-gray-700 hover:bg-gray-50' : 'text-slate-300 hover:bg-white/[0.06]'
                        }`}
                      >
                        Last {d} days
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              onClick={() => setViewMode(viewMode === 'recommended' ? 'current' : 'recommended')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md transition-all duration-150 ${
                viewMode === 'recommended'
                  ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-500/25'
                  : light ? 'text-gray-600 hover:text-gray-800 hover:bg-white' : 'text-slate-300 hover:text-slate-100 hover:bg-white/5'
              }`}
              title={viewMode === 'recommended' ? 'Switch to current state view' : 'Show recommendations'}
              aria-pressed={viewMode === 'recommended'}
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" />
              </svg>
              Recommendation
            </button>
          </div>

          <ViewToggle />
        </div>

        {/* Right: Utilities + Connect — utility icons stay hidden on cold
            start; only the Connect AWS button is exposed so the user has a
            single, obvious entry point alongside the welcome banner. */}
        <div className="flex items-center gap-0.5">
          {topologyData && <MaintenanceCalendar iconBtnClass={iconBtn} />}

          {topologyData && <>
          <button
            onClick={toggleRedactMode}
            className={`flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${
              light ? 'focus-visible:ring-offset-white' : 'focus-visible:ring-offset-slate-900'
            } ${
              redactMode
                ? 'bg-violet-500 text-white shadow-sm shadow-violet-500/25 hover:bg-violet-600'
                : light ? 'text-gray-500 hover:bg-gray-100 hover:text-gray-700' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            }`}
            title={redactMode ? 'Show sensitive info' : 'Redact sensitive info (account IDs, resource IDs, IPs, CIDRs)'}
            aria-label={redactMode ? 'Show sensitive info' : 'Redact sensitive info'}
            aria-pressed={redactMode}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {redactMode ? (
                <>
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </>
              ) : (
                <>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              )}
            </svg>
          </button>

          <button
            onClick={() => setIsSimulating(!isSimulating)}
            className={`flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${
              light ? 'focus-visible:ring-offset-white' : 'focus-visible:ring-offset-slate-900'
            } ${
              isSimulating
                ? 'bg-red-500 text-white shadow-sm shadow-red-500/25 hover:bg-red-600'
                : light ? 'text-gray-500 hover:bg-gray-100 hover:text-gray-700' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            }`}
            title={isSimulating ? 'Exit failure simulation' : 'Enter failure simulation'}
            aria-label={isSimulating ? 'Exit failure simulation' : 'Enter failure simulation'}
            aria-pressed={isSimulating}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </button>

          <button data-tour="chat" onClick={onToggleChat} className={iconBtn(chatOpen)} title={chatOpen ? 'Hide chat' : 'Show chat'} aria-label={chatOpen ? 'Hide chat panel' : 'Show chat panel'} aria-pressed={chatOpen}>
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>

          <div ref={overflowRef} className="relative">
            <button
              data-tour="overflow"
              onClick={() => setOverflowOpen(!overflowOpen)}
              disabled={isExporting}
              className={`${iconBtn(overflowOpen)} disabled:cursor-not-allowed`}
              title={isExporting ? 'Exporting…' : isLoading ? 'Refreshing…' : 'More options'}
              aria-label="More options"
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              aria-busy={isLoading || isExporting}
            >
              {isLoading || isExporting ? (
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="5" cy="12" r="1" />
                  <circle cx="12" cy="12" r="1" />
                  <circle cx="19" cy="12" r="1" />
                </svg>
              )}
            </button>
            {overflowOpen && (
              <div role="menu" className={`absolute top-full right-0 mt-1 py-1 rounded-lg shadow-lg border z-50 min-w-[280px] ${
                light
                  ? 'bg-white border-gray-200 shadow-gray-200/50'
                  : 'bg-slate-800 border-slate-700 shadow-black/40'
              }`}>
                {!importedSnapshot && (
                  <>
                    <button
                      role="menuitem"
                      onClick={() => { setOverflowOpen(false); onRefresh(); }}
                      disabled={isLoading}
                      className={`w-full flex items-center gap-2.5 text-left px-3 py-1.5 text-[11px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        light ? 'text-gray-700 hover:bg-gray-50' : 'text-slate-300 hover:bg-white/[0.06]'
                      }`}
                    >
                      <svg className={`w-3.5 h-3.5 opacity-60 flex-shrink-0 ${isLoading ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="23 4 23 10 17 10" />
                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                      </svg>
                      <span className="font-medium">{isLoading ? 'Refreshing…' : 'Refresh topology'}</span>
                    </button>
                    <div className={`my-1 h-px ${light ? 'bg-gray-100' : 'bg-slate-700/60'}`} />
                  </>
                )}
                <button
                  role="menuitem"
                  onClick={handleExportImage}
                  className={`w-full flex items-center gap-2.5 text-left px-3 py-1.5 text-[11px] transition-colors ${
                    light ? 'text-gray-700 hover:bg-gray-50' : 'text-slate-300 hover:bg-white/[0.06]'
                  }`}
                >
                  <svg className="w-3.5 h-3.5 opacity-60 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                  <span className="font-medium">Download topology image</span>
                </button>
                <div
                  className={`flex items-center flex-nowrap gap-2 px-3 py-1.5 text-[11px] whitespace-nowrap ${
                    light ? 'text-gray-700' : 'text-slate-300'
                  }`}
                >
                  <svg className="w-3.5 h-3.5 opacity-60 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  <span className="font-medium flex-1 min-w-0">Export snapshot</span>
                  <div
                    role="group"
                    aria-label="Export format"
                    className={`flex items-center flex-shrink-0 rounded-md p-0.5 ${light ? 'bg-gray-100' : 'bg-white/[0.06]'}`}
                  >
                    <button
                      role="menuitem"
                      onClick={handleExportSanitized}
                      disabled={!topologyData}
                      className={`px-2 py-0.5 text-[10px] font-semibold rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        light
                          ? 'text-emerald-700 hover:bg-emerald-100'
                          : 'text-emerald-300 hover:bg-emerald-500/15'
                      }`}
                      title={!topologyData
                        ? 'Load a topology first'
                        : 'Export with sanitized data — pseudo IDs only, safe to share'}
                    >
                      Sanitized
                    </button>
                    <span className={`mx-0.5 w-px h-3 ${light ? 'bg-gray-300' : 'bg-white/10'}`} aria-hidden="true" />
                    <button
                      role="menuitem"
                      onClick={handleExportFull}
                      disabled={!topologyData}
                      className={`px-2 py-0.5 text-[10px] font-semibold rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        light
                          ? 'text-amber-700 hover:bg-amber-100'
                          : 'text-amber-300 hover:bg-amber-500/15'
                      }`}
                      title={!topologyData
                        ? 'Load a topology first'
                        : 'Export with real data — file will contain real account IDs, resource IDs, IPs, and tags'}
                    >
                      Full
                    </button>
                  </div>
                </div>
                <button
                  role="menuitem"
                  onClick={handleImportClick}
                  className={`w-full flex items-center gap-2.5 text-left px-3 py-1.5 text-[11px] transition-colors ${
                    light ? 'text-gray-700 hover:bg-gray-50' : 'text-slate-300 hover:bg-white/[0.06]'
                  }`}
                  title="Import a customer-shared snapshot file"
                >
                  <svg className="w-3.5 h-3.5 opacity-60 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <span className="font-medium">Import snapshot</span>
                </button>
                <div className={`my-1 h-px ${light ? 'bg-gray-100' : 'bg-slate-700/60'}`} />
                <button
                  role="menuitem"
                  onClick={() => { setOverflowOpen(false); onStartTour(); }}
                  className={`w-full flex items-center gap-2.5 text-left px-3 py-1.5 text-[11px] transition-colors ${
                    light ? 'text-gray-700 hover:bg-gray-50' : 'text-slate-300 hover:bg-white/[0.06]'
                  }`}
                >
                  <svg className="w-3.5 h-3.5 opacity-60 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  <span className="font-medium">Take a tour</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => { setOverflowOpen(false); toggleTheme(); }}
                  className={`w-full flex items-center gap-2.5 text-left px-3 py-1.5 text-[11px] transition-colors ${
                    light ? 'text-gray-700 hover:bg-gray-50' : 'text-slate-300 hover:bg-white/[0.06]'
                  }`}
                >
                  {theme === 'dark' ? (
                    <svg className="w-3.5 h-3.5 opacity-60 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <circle cx="12" cy="12" r="5" />
                      <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                      <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5 opacity-60 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                    </svg>
                  )}
                  <span className="font-medium">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
                </button>
                <div className={`my-1 h-px ${light ? 'bg-gray-100' : 'bg-slate-700/60'}`} />
                <div
                  className={`px-3 py-1.5 text-[10px] font-mono tracking-tight select-text ${
                    light ? 'text-gray-400' : 'text-slate-500'
                  }`}
                  title="App version"
                >
                  v{config.appVersion}
                </div>
              </div>
            )}
          </div>

          <div className={`w-px h-5 mx-1.5 ${light ? 'bg-gray-200' : 'bg-slate-700/60'}`} />
          </>}

          {importedSnapshot ? (
            <div
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg ${
                light
                  ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                  : 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30'
              }`}
              title={`Snapshot exported ${new Date(importedSnapshot.exportedAt).toLocaleString()}${importedSnapshot.redactedView ? ' (sanitized)' : ''}`}
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              Imported snapshot
              {importedSnapshot.redactedView && (
                <span className={`text-[10px] font-normal ${light ? 'text-indigo-500/70' : 'text-indigo-400/70'}`}>
                  sanitized
                </span>
              )}
            </div>
          ) : isConnected ? (
            <div ref={connectMenuRef} className="relative">
              <button
                onClick={() => setConnectMenuOpen(!connectMenuOpen)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg transition-all duration-150 bg-emerald-500/10 text-emerald-600 border border-emerald-500/20 hover:bg-emerald-500/15`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 live-dot" />
                {credentials?.authMethod === 'sso' ? 'SSO Connected' : 'Connected'}
                {(() => {
                  // SSO carries the account on the session; access-key logins
                  // resolve it via STS GetCallerIdentity into the topology.
                  const acctId = credentials?.ssoMeta?.accountId || topologyData?.homeAccountId;
                  return acctId ? (
                    <span className={`text-[10px] font-normal ${light ? 'text-emerald-500/70' : 'text-emerald-400/60'}`}>
                      {redact(
                        acctId.replace(/^(\d{4})(\d{4})(\d{4})$/, '$1-$2-$3'),
                        redactMode,
                      )}
                    </span>
                  ) : null;
                })()}
                <svg className={`w-3 h-3 opacity-50 transition-transform ${connectMenuOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {connectMenuOpen && (
                <div className={`absolute top-full right-0 mt-1 py-1 rounded-lg shadow-lg border z-50 min-w-[140px] ${
                  light
                    ? 'bg-white border-gray-200 shadow-gray-200/50'
                    : 'bg-slate-800 border-slate-700 shadow-black/40'
                }`}>
                  <button
                    onClick={() => { setConnectMenuOpen(false); setShowCredentials(true); }}
                    className={`w-full flex items-center gap-2 text-left px-3 py-1.5 text-[11px] transition-colors ${
                      light ? 'text-gray-700 hover:bg-gray-50' : 'text-slate-300 hover:bg-white/[0.06]'
                    }`}
                  >
                    <svg className="w-3 h-3 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                    Settings
                  </button>
                  <div className={`my-1 h-px ${light ? 'bg-gray-100' : 'bg-slate-700/60'}`} />
                  <button
                    onClick={() => { setConnectMenuOpen(false); clearChat(); setCredentials(null); onRefresh(); }}
                    className={`w-full flex items-center gap-2 text-left px-3 py-1.5 text-[11px] transition-colors ${
                      light ? 'text-red-600 hover:bg-red-50' : 'text-red-400 hover:bg-red-500/10'
                    }`}
                  >
                    <svg className="w-3 h-3 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={() => setShowCredentials(true)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg transition-all duration-150 ${
                light
                  ? 'border border-blue-500 text-blue-600 hover:bg-blue-500/10'
                  : 'border border-blue-500 text-blue-400 hover:bg-blue-500/10'
              }`}
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                <polyline points="10 17 15 12 10 7" />
                <line x1="15" y1="12" x2="3" y2="12" />
              </svg>
              Connect AWS
            </button>
          )}
        </div>
      </div>

      {/* Live status disclaimer */}
      {showLiveStatus && !dismissedStatusDisclaimer && (
        <div className={`flex items-center justify-center gap-2.5 px-4 py-2 text-[11px] leading-relaxed ${
          isSimulating ? '' : 'border-b'
        } ${
          light ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-amber-900/15 border-amber-800/20 text-amber-300/90'
        }`}>
          <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>
            {importedSnapshot ? (
              <>
                Live status reflects the customer's view at{' '}
                <strong className="font-semibold">
                  {new Date(importedSnapshot.exportedAt).toLocaleString()}
                </strong>
                {' '}— not real-time. State has likely changed since the snapshot was exported.
              </>
            ) : (
              <>Status indicators reflect the last fetched state. Always verify operational status in the <strong className="font-semibold">AWS Management Console</strong> as the source of truth.</>
            )}
          </span>
          <button
            onClick={() => setDismissedStatusDisclaimer(true)}
            className={`ml-1 flex-shrink-0 p-1 rounded transition-colors ${light ? 'hover:bg-amber-100' : 'hover:bg-amber-800/30'}`}
            title="Dismiss"
            aria-label="Dismiss status disclaimer"
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* Simulation status bar */}
      {isSimulating && (
        <div className={`flex items-center justify-center gap-2.5 px-4 py-2 text-[11px] leading-relaxed border-b ${
          impactSummary
            ? 'bg-red-950/60 border-red-800/40 text-red-200'
            : light ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-amber-900/15 border-amber-800/20 text-amber-300/90'
        }`}>
          <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
          {impactSummary ? (
            <span>
              <strong>{impactSummary.failedNodes} node{impactSummary.failedNodes !== 1 ? 's' : ''}</strong>
              {impactSummary.failedLinks > 0 && <>, <strong>{impactSummary.failedLinks} link{impactSummary.failedLinks !== 1 ? 's' : ''}</strong></>}
              {' '}failed — <strong>{impactSummary.downEdges}</strong> of {impactSummary.totalEdges} paths down, <strong className="text-green-400">{impactSummary.upEdges} surviving</strong>
            </span>
          ) : (
            <span>Click on zones, nodes, or edges to simulate failures</span>
          )}
          {hasFailures && (
            <button
              onClick={clearFailures}
              className={`ml-1 px-2 py-0.5 text-[10px] font-semibold rounded-md transition-colors ${
                impactSummary
                  ? 'text-red-200 hover:text-white hover:bg-red-500/20 border border-red-400/30'
                  : light
                    ? 'text-amber-700 hover:bg-amber-100 border border-amber-300'
                    : 'text-amber-200 hover:bg-amber-500/20 border border-amber-400/30'
              }`}
              title="Clear all failures"
            >
              Reset
            </button>
          )}
        </div>
      )}

      {showCredentials && (
        <CredentialsModal
          onClose={() => setShowCredentials(false)}
          onConnect={() => {
            setShowCredentials(false);
            onRefresh();
          }}
        />
      )}

      {showFullExportConfirm && (
        <FullExportConfirmModal
          onCancel={() => setShowFullExportConfirm(false)}
          onConfirm={handleFullExportConfirmed}
        />
      )}

      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        onChange={handleImportFile}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      />
    </>
  );
}
