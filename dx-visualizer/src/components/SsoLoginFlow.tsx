import { useState, useRef, useCallback, useEffect } from 'react';
import { useTopologyStore } from '../store/topology-store';
import { useIsLight } from '../hooks/useTheme';
import {
  ssoStart,
  ssoPoll,
  ssoListAccounts,
  ssoListRoles,
  ssoConnect,
  getSavedBackendUrl,
  saveBackendUrl,
  type SsoStartResult,
  type SsoAccount,
  type SsoRole,
} from '../api/sso-api';

type Step = 'input' | 'authorizing' | 'selectAccount' | 'connecting' | 'error';

const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2', 'ap-south-1',
  'sa-east-1', 'ca-central-1', 'me-south-1', 'af-south-1',
];

interface Props {
  onConnect: () => void;
  onCancel: () => void;
}

export function SsoLoginFlow({ onConnect, onCancel }: Props) {
  const setCredentials = useTopologyStore((s) => s.setCredentials);
  const setHomeAccountName = useTopologyStore((s) => s.setHomeAccountName);
  const light = useIsLight();

  const [step, setStep] = useState<Step>('input');
  const [error, setError] = useState('');

  // Input step
  const [backendUrl, setBackendUrl] = useState(getSavedBackendUrl);
  const [startUrl, setStartUrl] = useState('');
  const [ssoRegion, setSsoRegion] = useState('us-east-1');

  // Authorizing step
  const [deviceInfo, setDeviceInfo] = useState<SsoStartResult | null>(null);
  const cancelRef = useRef(false);

  // Select account step
  const [accessToken, setAccessToken] = useState('');
  const [accounts, setAccounts] = useState<SsoAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [roles, setRoles] = useState<SsoRole[]>([]);
  const [selectedRole, setSelectedRole] = useState('');
  const [loadingRoles, setLoadingRoles] = useState(false);

  // Multi-account enrichment
  const [showEnrich, setShowEnrich] = useState(false);
  const [spokeAccountsRaw, setSpokeAccountsRaw] = useState('');

  const inputCls = `w-full border rounded-lg px-3 py-2 text-sm transition-colors focus:outline-none ${
    light
      ? 'bg-white border-slate-200 text-slate-700 placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-400/15'
      : 'bg-slate-700 border-slate-600 text-white focus:border-blue-500'
  }`;
  const labelCls = `block text-xs font-medium mb-1.5 ${light ? 'text-slate-600' : 'text-slate-400'}`;
  const btnPrimary = `flex-1 text-sm font-medium rounded-lg py-2.5 transition-colors ${
    light ? 'bg-blue-500 text-white shadow-sm hover:bg-blue-600' : 'bg-blue-600 text-white hover:bg-blue-500'
  }`;
  const btnSecondary = `flex-1 text-sm font-medium rounded-lg py-2.5 transition-colors ${
    light ? 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
  }`;

  const handleError = useCallback((msg: string) => {
    setError(msg);
    setStep('error');
  }, []);

  // Start SSO flow
  const handleStart = async () => {
    if (!backendUrl.trim()) return handleError('Backend URL is required');
    if (!startUrl.trim()) return handleError('SSO Start URL is required');

    try {
      saveBackendUrl(backendUrl.trim());
    } catch (err) {
      return handleError(err instanceof Error ? err.message : 'Invalid backend URL');
    }
    setStep('authorizing');
    cancelRef.current = false;

    try {
      const result = await ssoStart(startUrl.trim(), ssoRegion, backendUrl.trim());
      setDeviceInfo(result);

      // Open verification URL in new tab
      window.open(result.verificationUriComplete, '_blank');

      // Start polling
      const interval = (result.interval || 5) * 1000;
      let elapsed = 0;
      const timeout = (result.expiresIn || 600) * 1000;

      while (!cancelRef.current && elapsed < timeout) {
        await new Promise((r) => setTimeout(r, interval));
        if (cancelRef.current) return;
        elapsed += interval;

        try {
          const poll = await ssoPoll(ssoRegion, result.clientId, result.deviceCode, backendUrl.trim());
          if (poll.status === 'success' && poll.accessToken) {
            setAccessToken(poll.accessToken);
            // Fetch accounts
            const { accounts: accts } = await ssoListAccounts(ssoRegion, poll.accessToken, backendUrl.trim());
            setAccounts(accts);
            if (accts.length === 1) setSelectedAccountId(accts[0].accountId);
            setStep('selectAccount');
            return;
          }
        } catch (pollErr) {
          if ((pollErr as { message?: string }).message?.includes('expired')) {
            handleError('Authorization expired. Please try again.');
            return;
          }
          // Ignore transient errors during polling
        }
      }

      if (!cancelRef.current) {
        handleError('Authorization timed out. Please try again.');
      }
    } catch (err) {
      if (!cancelRef.current) {
        handleError(err instanceof Error ? err.message : 'Failed to start SSO flow');
      }
    }
  };

  const handleCancel = () => {
    cancelRef.current = true;
    setStep('input');
  };

  // Load roles when account is selected
  useEffect(() => {
    if (!selectedAccountId || !accessToken) return;
    setLoadingRoles(true);
    setSelectedRole('');
    ssoListRoles(ssoRegion, accessToken, selectedAccountId, backendUrl.trim())
      .then(({ roles: r }) => {
        setRoles(r);
        if (r.length === 1) setSelectedRole(r[0].roleName);
      })
      .catch((err) => handleError(err instanceof Error ? err.message : 'Failed to load roles'))
      .finally(() => setLoadingRoles(false));
  }, [selectedAccountId, accessToken, ssoRegion, backendUrl, handleError]);

  // Connect with selected account/role
  const handleConnect = async () => {
    if (!selectedAccountId || !selectedRole) return;
    setStep('connecting');
    try {
      const creds = await ssoConnect(ssoRegion, accessToken, selectedAccountId, selectedRole, backendUrl.trim());
      const spokeAccounts = showEnrich
        ? spokeAccountsRaw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
        : undefined;
      const selectedAccount = accounts.find((a) => a.accountId === selectedAccountId);
      setHomeAccountName(selectedAccount?.accountName ?? null);
      setCredentials({
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
        region: ssoRegion,
        authMethod: 'sso',
        ssoMeta: {
          expiration: creds.expiration,
          ssoRegion,
          accountId: selectedAccountId,
          roleName: selectedRole,
        },
        spokeAccounts: spokeAccounts?.length ? spokeAccounts : undefined,
      });
      onConnect();
    } catch (err) {
      handleError(err instanceof Error ? err.message : 'Failed to get credentials');
    }
  };

  // Input step
  if (step === 'input') {
    return (
      <div className="space-y-3">
        <div>
          <label className={labelCls}>Backend URL</label>
          <input
            type="url"
            value={backendUrl}
            onChange={(e) => setBackendUrl(e.target.value)}
            className={inputCls}
            placeholder="https://abc123.execute-api.us-east-1.amazonaws.com"
          />
          <p className="text-[10px] mt-1.5 text-slate-500">
            Deploy the backend stack in your AWS account to get this URL.
          </p>
        </div>
        <div>
          <label className={labelCls}>Start URL</label>
          <input
            type="url"
            value={startUrl}
            onChange={(e) => setStartUrl(e.target.value)}
            className={inputCls}
            placeholder="https://my-org.awsapps.com/start"
          />
        </div>
        <div>
          <label className={labelCls}>Region</label>
          <select
            value={ssoRegion}
            onChange={(e) => setSsoRegion(e.target.value)}
            className={inputCls}
          >
            {AWS_REGIONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
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
            <div className="mt-2">
              <label className={labelCls}>Spoke Account IDs</label>
              <input
                type="text"
                value={spokeAccountsRaw}
                onChange={(e) => setSpokeAccountsRaw(e.target.value)}
                className={inputCls}
                placeholder="222222222222, 333333333333"
              />
              <p className="text-[10px] mt-1.5 text-slate-500">
                Comma-separated. The app assumes a role in each account to fetch VPC names and CIDRs.
              </p>
            </div>
          )}
        </div>

        <div className="flex gap-2 pt-2">
          <button onClick={handleStart} className={btnPrimary}>
            Connect
          </button>
          <button onClick={onCancel} className={btnSecondary}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Authorizing step
  if (step === 'authorizing') {
    return (
      <div className="space-y-4 text-center py-4">
        <div className={`animate-spin w-8 h-8 mx-auto border-2 border-t-transparent rounded-full ${light ? 'border-blue-500' : 'border-blue-400'}`} />
        <div>
          <p className={`text-sm font-medium ${light ? 'text-slate-700' : 'text-slate-200'}`}>
            Waiting for authorization...
          </p>
          <p className={`text-xs mt-1 ${light ? 'text-slate-500' : 'text-slate-400'}`}>
            A browser tab has been opened. Complete the sign-in there.
          </p>
        </div>
        {deviceInfo && (
          <div className={`rounded-lg p-4 ${light ? 'bg-slate-50 border border-slate-200/80' : 'bg-slate-700/50 border border-slate-600'}`}>
            <p className={`text-[10px] font-medium mb-1.5 ${light ? 'text-slate-500' : 'text-slate-400'}`}>Your verification code</p>
            <p className={`text-lg font-mono font-bold tracking-widest ${light ? 'text-slate-700' : 'text-white'}`}>
              {deviceInfo.userCode}
            </p>
            <a
              href={deviceInfo.verificationUriComplete}
              target="_blank"
              rel="noopener noreferrer"
              className={`text-[11px] underline mt-1.5 inline-block ${light ? 'text-blue-600 hover:text-blue-700' : 'text-blue-400 hover:text-blue-300'}`}
            >
              Open authorization page
            </a>
          </div>
        )}
        <button onClick={handleCancel} className={`text-xs ${light ? 'text-slate-500 hover:text-slate-700' : 'text-slate-400 hover:text-slate-200'}`}>
          Cancel
        </button>
      </div>
    );
  }

  // Select account step
  if (step === 'selectAccount') {
    return (
      <div className="space-y-3">
        <div className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-[11px] ${light ? 'bg-emerald-50 text-emerald-700' : 'bg-emerald-900/20 text-emerald-400'}`}>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          SSO authenticated successfully
        </div>
        <div>
          <label className={labelCls}>Account</label>
          <select
            value={selectedAccountId}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            className={inputCls}
          >
            <option value="">Select an account...</option>
            {accounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.accountName} ({a.accountId})
              </option>
            ))}
          </select>
        </div>
        {selectedAccountId && (
          <div>
            <label className={labelCls}>Role</label>
            {loadingRoles ? (
              <p className={`text-xs ${light ? 'text-slate-400' : 'text-slate-500'}`}>Loading roles...</p>
            ) : (
              <select
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value)}
                className={inputCls}
              >
                <option value="">Select a role...</option>
                {roles.map((r) => (
                  <option key={r.roleName} value={r.roleName}>
                    {r.roleName}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
        <div className="flex gap-2 pt-2">
          <button
            onClick={handleConnect}
            disabled={!selectedAccountId || !selectedRole}
            className={`${btnPrimary} ${(!selectedAccountId || !selectedRole) ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            Connect
          </button>
          <button onClick={onCancel} className={btnSecondary}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Connecting step
  if (step === 'connecting') {
    return (
      <div className="space-y-4 text-center py-6">
        <div className={`animate-spin w-8 h-8 mx-auto border-2 border-t-transparent rounded-full ${light ? 'border-blue-500' : 'border-blue-400'}`} />
        <p className={`text-sm ${light ? 'text-slate-600' : 'text-slate-300'}`}>Fetching credentials...</p>
      </div>
    );
  }

  // Error step
  return (
    <div className="space-y-4 text-center py-4">
      <div className={`rounded-lg p-3 ${light ? 'bg-red-50 border border-red-200' : 'bg-red-900/20 border border-red-800/30'}`}>
        <p className={`text-sm ${light ? 'text-red-700' : 'text-red-400'}`}>{error}</p>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => { setError(''); setStep('input'); }}
          className={btnPrimary}
        >
          Try Again
        </button>
        <button onClick={onCancel} className={btnSecondary}>
          Cancel
        </button>
      </div>
    </div>
  );
}
