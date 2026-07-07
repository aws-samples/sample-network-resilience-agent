import { useState } from 'react';
import { useTopologyStore } from '../store/topology-store';
import { useIsLight } from '../hooks/useTheme';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { SsoLoginFlow } from './SsoLoginFlow';

interface Props {
  onClose: () => void;
  onConnect: () => void;
}

type AuthTab = 'accessKey' | 'sso';

export function CredentialsModal({ onClose, onConnect }: Props) {
  const setCredentials = useTopologyStore((s) => s.setCredentials);
  const light = useIsLight();
  const [activeTab, setActiveTab] = useState<AuthTab>('sso');

  // Temporary credentials form state
  const trapRef = useFocusTrap(true, onClose);
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [showEnrich, setShowEnrich] = useState(false);
  const [spokeAccountsRaw, setSpokeAccountsRaw] = useState('');
  const [crossAccountRoleName] = useState('NetworkReadOnlyRole');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const spokeAccounts = showEnrich
      ? spokeAccountsRaw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
      : undefined;
    setCredentials({
      accessKeyId,
      secretAccessKey,
      sessionToken,
      region: 'us-east-1',
      authMethod: 'accessKey',
      spokeAccounts: spokeAccounts?.length ? spokeAccounts : undefined,
      crossAccountRoleName: spokeAccounts?.length ? crossAccountRoleName : undefined,
    });
    onConnect();
  };

  const tabCls = (active: boolean) =>
    `flex-1 text-xs font-medium py-2 rounded-md transition-all ${
      active
        ? light
          ? 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200/70'
          : 'bg-slate-700 text-white shadow-sm'
        : light
          ? 'text-slate-500 hover:text-slate-700'
          : 'text-slate-400 hover:text-slate-200'
    }`;

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${light ? 'bg-slate-900/30 backdrop-blur-md' : 'bg-black/60'}`} onClick={onClose}>
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="credentials-modal-title"
        className={`rounded-2xl border p-7 w-[460px] ${light ? 'bg-[#fafbfc] border-slate-200/70 shadow-[0_24px_60px_-20px_rgba(15,23,42,0.18)]' : 'bg-slate-800 border-slate-600 shadow-2xl'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="credentials-modal-title" className={`text-[17px] font-semibold mb-5 tracking-tight ${light ? 'text-slate-700' : 'text-white'}`}>Connect to AWS</h2>

        {/* Tab bar */}
        <div className={`flex gap-1 p-1 rounded-lg mb-5 ${light ? 'bg-slate-100/80' : 'bg-slate-900/50'}`}>
          <button onClick={() => setActiveTab('accessKey')} className={tabCls(activeTab === 'accessKey')}>
            Temporary Credentials
          </button>
          <button onClick={() => setActiveTab('sso')} className={tabCls(activeTab === 'sso')}>
            Identity Center
          </button>
        </div>

        {activeTab === 'accessKey' ? (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label htmlFor="cred-access-key" className={`block text-xs font-medium mb-1.5 ${light ? 'text-slate-600' : 'text-slate-400'}`}>Access Key ID</label>
              <input
                id="cred-access-key"
                type="text"
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
                className={`w-full border rounded-lg px-3 py-2 text-sm transition-colors focus:outline-none ${light ? 'bg-white border-slate-200 text-slate-700 placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-400/15' : 'bg-slate-700 border-slate-600 text-white focus:border-blue-500'}`}
                required
              />
            </div>
            <div>
              <label htmlFor="cred-secret-key" className={`block text-xs font-medium mb-1.5 ${light ? 'text-slate-600' : 'text-slate-400'}`}>Secret Access Key</label>
              <input
                id="cred-secret-key"
                type="password"
                value={secretAccessKey}
                onChange={(e) => setSecretAccessKey(e.target.value)}
                className={`w-full border rounded-lg px-3 py-2 text-sm transition-colors focus:outline-none ${light ? 'bg-white border-slate-200 text-slate-700 placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-400/15' : 'bg-slate-700 border-slate-600 text-white focus:border-blue-500'}`}
                required
              />
            </div>
            <div>
              <label htmlFor="cred-session-token" className={`block text-xs font-medium mb-1.5 ${light ? 'text-slate-600' : 'text-slate-400'}`}>Session Token</label>
              <textarea
                id="cred-session-token"
                value={sessionToken}
                onChange={(e) => setSessionToken(e.target.value)}
                rows={3}
                className={`w-full border rounded-lg px-3 py-2 text-sm transition-colors focus:outline-none resize-none ${light ? 'bg-white border-slate-200 text-slate-700 placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-400/15' : 'bg-slate-700 border-slate-600 text-white focus:border-blue-500'}`}
                required
              />
            </div>
            <div className={`border-t pt-3 mt-1 ${light ? 'border-slate-200/80' : 'border-slate-700'}`}>
              <button
                type="button"
                onClick={() => setShowEnrich(!showEnrich)}
                className={`flex items-center gap-1.5 text-xs transition-colors ${light ? 'text-slate-500 hover:text-slate-700' : 'text-slate-400 hover:text-slate-300'}`}
              >
                <span className={`transition-transform ${showEnrich ? 'rotate-90' : ''}`}>&#9654;</span>
                Multi-Account VPC Discovery (optional)
              </button>
              {showEnrich && (
                <div className="mt-2 space-y-2">
                  <div>
                    <label htmlFor="cred-spoke-accounts" className={`block text-xs font-medium mb-1.5 ${light ? 'text-slate-600' : 'text-slate-400'}`}>Spoke Account IDs</label>
                    <input
                      id="cred-spoke-accounts"
                      type="text"
                      value={spokeAccountsRaw}
                      onChange={(e) => setSpokeAccountsRaw(e.target.value)}
                      className={`w-full border rounded-lg px-3 py-2 text-sm transition-colors focus:outline-none ${light ? 'bg-white border-slate-200 text-slate-700 placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-400/15' : 'bg-slate-700 border-slate-600 text-white focus:border-blue-500'}`}
                      placeholder="222222222222, 333333333333"
                    />
                    <p className="text-[10px] mt-1.5 text-slate-500">
                      Comma-separated. The app assumes a role in each account to fetch VPC names and CIDRs.
                    </p>
                  </div>
                  <div>
                    <label htmlFor="cred-role-name" className={`block text-xs font-medium mb-1.5 ${light ? 'text-slate-600' : 'text-slate-400'}`}>IAM Role Name</label>
                    <input
                      id="cred-role-name"
                      type="text"
                      value={crossAccountRoleName}
                      readOnly
                      className={`w-full border rounded-lg px-3 py-2 text-sm cursor-not-allowed focus:outline-none ${light ? 'bg-slate-50 border-slate-200 text-slate-500' : 'bg-slate-800 border-slate-700 text-slate-400'}`}
                      placeholder="NetworkReadOnlyRole"
                    />
                  </div>
                </div>
              )}
            </div>
            {/* Security best practices */}
            <div className={`rounded-lg p-3.5 text-[11px] leading-relaxed ${light ? 'bg-blue-50/60 border border-blue-200/70 text-blue-900/80' : 'bg-blue-900/20 border border-blue-700/40 text-blue-300'}`}>
              <p className={`font-semibold mb-1.5 ${light ? 'text-blue-900' : ''}`}>Temporary credentials only</p>
              <ul className="space-y-1 list-disc pl-3.5">
                <li>Obtain via <strong>STS AssumeRole</strong>, <strong>GetSessionToken</strong>, or <strong>aws sts get-session-token</strong> CLI</li>
                <li>Grant <strong>least-privilege</strong> permissions &mdash; only the read-only APIs this tool needs</li>
                <li>Credentials expire automatically &mdash; no long-lived keys accepted</li>
                <li>Consider <strong>Identity Center (SSO)</strong> tab for a fully managed flow</li>
              </ul>
            </div>
            <div className="flex gap-2 pt-3">
              <button
                type="submit"
                className={`flex-1 text-sm font-medium rounded-lg py-2.5 transition-colors ${light ? 'bg-blue-500 text-white shadow-sm hover:bg-blue-600' : 'bg-blue-600 text-white hover:bg-blue-500'}`}
              >
                Connect
              </button>
              <button
                type="button"
                onClick={onClose}
                className={`flex-1 text-sm font-medium rounded-lg py-2.5 transition-colors ${light ? 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <SsoLoginFlow onConnect={onConnect} onCancel={onClose} />
        )}

        <p className={`mt-4 text-[10px] text-center ${light ? 'text-slate-400' : 'text-slate-500'}`}>
          Credentials are stored in memory only and never persisted.
        </p>
      </div>
    </div>
  );
}
