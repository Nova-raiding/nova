import { useCallback, useEffect, useRef, useState } from "react";
import { deliveryGovernanceClient, type DeliveryGovernanceClient, type DeliveryReadiness } from "../api/deliveryGovernanceClient.js";
import { describeOpsError } from "../api/opsClient.js";

export class DeliveryGovernanceRequestGate {
  private current = 0;
  begin() { return ++this.current; }
  isCurrent(request: number) { return request === this.current; }
  invalidate() { this.current += 1; }
}

export interface DeliveryGovernanceModel {
  data: DeliveryReadiness | null;
  loaded: boolean;
  loading: boolean;
  error?: string;
  reload(): Promise<void>;
}

export function useDeliveryGovernance(client: DeliveryGovernanceClient = deliveryGovernanceClient): DeliveryGovernanceModel {
  const [data, setData] = useState<DeliveryReadiness | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const gate = useRef(new DeliveryGovernanceRequestGate());
  const controller = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    controller.current?.abort();
    const activeController = new AbortController();
    controller.current = activeController;
    const request = gate.current.begin();
    setLoading(true);
    setError(undefined);
    try {
      const value = await client.get(activeController.signal);
      if (!gate.current.isCurrent(request)) return;
      setData(value);
      setLoaded(true);
    } catch (cause) {
      if (activeController.signal.aborted || !gate.current.isCurrent(request)) return;
      setData(null);
      setLoaded(true);
      setError(describeOpsError(cause));
    } finally {
      if (gate.current.isCurrent(request)) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void reload();
    return () => {
      gate.current.invalidate();
      controller.current?.abort();
    };
  }, [reload]);

  return { data, loaded, loading, ...(error ? { error } : {}), reload };
}
