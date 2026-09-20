import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "../apiBase.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatReplayDate(timestamp) {
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(new Date(timestamp));
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
      const response = await fetch(apiUrl(`/api/replay/${action}`), {
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

  const currentRate = Number(replay.rate) || 1;

  return (
    <section className="replay-player-card" aria-label="Replay timeline controls">
      {/* 1. 顶部标题与日期胶囊 */}
      <div className="replay-card-header">
        <div className="replay-title-wrap">
          <span className="replay-title-dot" />
          <h2 className="replay-title-text">Replay Session</h2>
          {displayedTime && (
            <span className="replay-date-pill">
              📅 {formatReplayDate(displayedTime)}
            </span>
          )}
        </div>
        <span className="replay-pct-badge">{Math.round(displayedProgress * 100)}%</span>
      </div>

      {/* 2. 现代流体进度条 */}
      <div className="replay-scrubber-box">
        <input
          className="modern-replay-slider"
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
      </div>

      {/* 3. 三栏对齐的时间戳 */}
      <div className="replay-time-display">
        <span className="time-bound">{formatReplayTime(replay.startTime)}</span>
        <span className="time-current-glow">{formatReplayTime(displayedTime)}</span>
        <span className="time-bound">{formatReplayTime(replay.endTime)}</span>
      </div>

      {/* 4. 播放按钮与倍速快捷胶囊 */}
      <div className="replay-control-bar">
        <button
          type="button"
          className={`replay-btn-toggle ${replay.isPlaying ? "btn-pause" : "btn-play"}`}
          onClick={() => sendControl(replay.isPlaying ? "pause" : "play")}
          disabled={pending}
        >
          {replay.isPlaying ? "⏸ Pause" : "▶ Play"}
        </button>

        <div className="replay-speed-selector">
          {[0.5, 1, 2, 4].map((speed) => (
            <button
              key={speed}
              type="button"
              className={`speed-pill ${currentRate === speed ? "speed-active" : ""}`}
              onClick={() => sendControl("rate", { rate: speed })}
              disabled={pending}
            >
              {speed}×
            </button>
          ))}
        </div>
      </div>

      {requestError && <p className="replay-error">{requestError}</p>}
    </section>
  );
}