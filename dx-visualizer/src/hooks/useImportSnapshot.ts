import { useCallback } from 'react';
import { useTopologyStore } from '../store/topology-store';
import { validateSnapshot, SnapshotValidationError } from '../utils/snapshot';

export function useImportSnapshot() {
  return useCallback(async (file: File) => {
    const setError = useTopologyStore.getState().setError;
    let text: string;
    try {
      text = await file.text();
    } catch (err) {
      setError(`Could not read snapshot file: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setError(`Snapshot file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let validated;
    try {
      validated = validateSnapshot(parsed);
    } catch (err) {
      setError(err instanceof SnapshotValidationError
        ? err.message
        : `Snapshot validation failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setError(null);
    useTopologyStore.getState().loadSnapshot(validated);
  }, []);
}
