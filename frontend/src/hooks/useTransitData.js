import { useEffect, useState } from "react";
import { createMockState, normalizeTransitMessage } from "../services/transitData.js";
import { apiUrl } from "../apiBase.js";

export function useTransitData() {
  const [state, setState] = useState(null);
  const [connectionMode, setConnectionMode] = useState("connecting");
  const [error, setError] = useState(null);

  useEffect(() => {
    let disposed = false;
    let receivedLiveState = false;
    const applyLiveState = (raw) => {
      if (disposed) return;
      receivedLiveState = true;
      setState(normalizeTransitMessage(raw));
      setConnectionMode("live");
      setError(null);
    };
    const useMockState = (reason) => {
      if (disposed || receivedLiveState) return;
      setState(createMockState());
      setConnectionMode("mock");
      setError(reason);
    };

    fetch(apiUrl("/api/state"))
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(applyLiveState)
      .catch((requestError) => useMockState(requestError.message || "Backend unavailable"));

    const source = new EventSource(apiUrl("/api/events"));
    source.onmessage = (event) => {
      try {
        applyLiveState(JSON.parse(event.data));
      } catch {
        // Ignore an invalid event and keep the last valid display state.
      }
    };
    source.onerror = () => {
      if (!receivedLiveState) useMockState("Backend unavailable — local demo data is shown");
    };

    return () => {
      disposed = true;
      source.close();
    };
  }, []);

  return { state, connectionMode, error };
}
