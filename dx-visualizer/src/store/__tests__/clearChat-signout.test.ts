// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTopologyStore } from '../topology-store';

const CHAT_STORAGE_KEY = 'dx-viz-chat';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

vi.stubGlobal('localStorage', localStorageMock);

function seedChatWithSensitiveData() {
  const messages = [
    { id: '1', role: 'user' as const, content: 'Show my VPCs', timestamp: 1 },
    { id: '2', role: 'assistant' as const, content: 'VPC vpc-0abc123 CIDR 10.0.0.0/16 in account 123456789012 with BGP ASN 64512', timestamp: 2 },
    { id: '3', role: 'user' as const, content: 'What about DX gateways?', timestamp: 3 },
    { id: '4', role: 'assistant' as const, content: 'DXGW dxgw-abc connected to VGW vgw-xyz in ap-southeast-1', timestamp: 4 },
  ];
  localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages));
  useTopologyStore.setState({ chatMessages: messages });
}

describe('clearChat on sign-out', () => {
  beforeEach(() => {
    localStorageMock.clear();
    useTopologyStore.setState({ chatMessages: [] });
  });

  it('removes sensitive network topology data from localStorage', () => {
    seedChatWithSensitiveData();
    expect(JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY)!)).toHaveLength(4);

    useTopologyStore.getState().clearChat();

    const stored = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe('welcome');
    expect(stored[0].content).not.toContain('vpc-');
    expect(stored[0].content).not.toContain('123456789012');
    expect(stored[0].content).not.toContain('10.0.0.0/16');
  });

  it('resets in-memory chat to only the welcome message', () => {
    seedChatWithSensitiveData();
    expect(useTopologyStore.getState().chatMessages).toHaveLength(4);

    useTopologyStore.getState().clearChat();

    const messages = useTopologyStore.getState().chatMessages;
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('welcome');
    expect(messages[0].role).toBe('assistant');
  });

  it('does not leave stale chat in localStorage after sign-out sequence', () => {
    seedChatWithSensitiveData();

    // Simulate the sign-out flow: clearChat() -> setCredentials(null)
    const store = useTopologyStore.getState();
    store.clearChat();
    store.setCredentials(null);

    const stored = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe('welcome');
  });

  it('is idempotent — calling clearChat multiple times is safe', () => {
    seedChatWithSensitiveData();

    useTopologyStore.getState().clearChat();
    useTopologyStore.getState().clearChat();

    const stored = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe('welcome');
  });
});
