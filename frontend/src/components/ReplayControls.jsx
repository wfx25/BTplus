import { useEffect, useMemo, useState } from "react";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatReplayTime(timestamp) {
  if (!Number.isFinite(timestamp)) return "--:--:--";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}

export default function ReplayControls({ replay, stateTimestamp }) {
  const [now, setNow] = useState(Date.now());
  const [draftProgress, setDraftProgress] = useState(null);
  const [pending, setPending] = useState(false);
  const [requestError, setRequestError] = useState(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  const displayedProgress = useMemo(() => {
    if (!replay) return 0;
    if (draftProgress != null) return draftProgress;
    const duration = Math.max(1, replay.endTime - replay.startTime);
    const localElapsed = replay.isPlaying
      ? Math.max(0, now - (stateTimestamp || now)) * (replay.rate || 1)
      : 0;
    return clamp(
      (replay.currentTime + localElapsed - replay.startTime) / duration,
      0,
      1
    );
  }, [draftProgress, now, replay, stateTimestamp]);

  const displayedTime = replay
    ? replay.startTime + displayedProgress * (replay.endTime - replay.startTime)
    : null;

  async function sendControl(action, body = {}) {
    setPending(true);
    setRequestError(null);
    try {
      const response = await fetch(`/api/replay/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
    } catch (error) {
      setRequestError(error.message || "Replay control request failed");
    } finally {
      setPending(false);
    }
  }

  function commitSeek(value) {
    const progress = clamp(Number(value), 0, 1);
    setDraftProgress(null);
    sendControl("seek", { progress });
  }

  if (!replay) return null;

  return (
    <section className="replay-controls" aria-label="Replay timeline controls">
      <div className="replay-title-row">
        <h2>Replay timeline</h2>
        <span>{Math.round(displayedProgress * 100)}%</span>
      </div>
      <input
        className="replay-slider"
        type="range"
        min="0"
        max="1000"
        step="1"
        value={Math.round(displayedProgress * 1000)}
        aria-label="Replay progress"
        onChange={(event) => setDraftProgress(Number(event.target.value) / 1000)}
        onPointerUp={(event) => commitSeek(Number(event.currentTarget.value) / 1000)}
        onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            commitSeek(Number(event.currentTarget.value) / 1000);
          }
        }}
        disabled={pending}
      />
      <div className="replay-times">
        <span>{formatReplayTime(replay.startTime)}</span>
        <strong>{formatReplayTime(displayedTime)}</strong>
        <span>{formatReplayTime(replay.endTime)}</span>
      </div>
      <div className="replay-actions">
        <button
          type="button"
          onClick={() => sendControl(replay.isPlaying ? "pause" : "play")}
          disabled={pending}
        >
          {replay.isPlaying ? "Pause" : "Play"}
        </button>
        <label>
          Speed
          <select
            value={replay.rate}
            disabled={pending}
            onChange={(event) => sendControl("rate", { rate: Number(event.target.value) })}
          >
            <option value="0.5">0.5×</option>
            <option value="1">1×</option>
            <option value="2">2×</option>
            <option value="4">4×</option>
          </select>
        </label>
      </div>
      <p className="note">Drag to preview a time; release to seek. Seeking pauses playback and resets validation for the new replay session.</p>
      {requestError && <p className="replay-error">{requestError}</p>}
    </section>
  );
}
