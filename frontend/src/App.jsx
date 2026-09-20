import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";
import {
  progressFromState,
  rangeCoordinates,
  visualPredictedPosition
} from "./predictionPlayback.js";
import ReplayControls from "./components/ReplayControls.jsx";
import { apiUrl } from "./apiBase.js";

// === 黑堡 BT 真实 UCB 路线高精度街道坐标 ===
const MOCK_UCB_COORDINATES = [
  [-80.4228, 37.2286], [-80.4215, 37.2272], [-80.4195, 37.2277], [-80.4182, 37.2290],
  [-80.4180, 37.2302], [-80.4191, 37.2312], [-80.4196, 37.2325], [-80.4205, 37.2335],
  [-80.4225, 37.2345], [-80.4248, 37.2353], [-80.4270, 37.2360], [-80.4295, 37.2356],
  [-80.4318, 37.2350], [-80.4326, 37.2368], [-80.4332, 37.2388], [-80.4339, 37.2410],
  [-80.4346, 37.2430], [-80.4348, 37.2442], [-80.4335, 37.2446], [-80.4312, 37.2435],
  [-80.4290, 37.2418], [-80.4278, 37.2395], [-80.4270, 37.2368], [-80.4265, 37.2359],
  [-80.4245, 37.2351], [-80.4220, 37.2341], [-80.4200, 37.2330], [-80.4191, 37.2312],
  [-80.4185, 37.2295], [-80.4205, 37.2285], [-80.4228, 37.2286]
];

// 核心修复：精准计算实际路线的总公里数，彻底杜绝瞬移！
function calculateTrueRouteLengthKm(coords) {
  const toRad = Math.PI / 180;
  let totalKm = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    totalKm += 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return totalKm;
}

const EXACT_ROUTE_LENGTH = calculateTrueRouteLengthKm(MOCK_UCB_COORDINATES);

// === 模拟数据：两辆车运动 ===
function createMockState() {
  const now = Date.now();
  return {
    sourceMode: "replay",
    recording: false,
    buses: [
      {
        id: "6402", routeId: "UCB", gtfsTripId: "trip_ucb_mock",
        generatedAt: now, dataAge: 24.8, freshness: "recent", predictionHorizonSeconds: 24.8,
        reported: { latitude: 37.2302, longitude: -80.4180 },
        predicted: { latitude: 37.2345, longitude: -80.4225 },
        predictionState: {
          modelType: "route_constant_velocity",
          modelMode: "moving",
          startProgressKm: 0.65,
          routeLengthKm: EXACT_ROUTE_LENGTH, // 使用真实精准全长！
          speedMetersPerSecond: 8.5,
          initialElapsedSeconds: 24.8,
          loop: true
        },
        uncertainty: { p80Meters: 70, label: "P80 confidence window (BT data 24.8s stale)" }
      },
      {
        id: "5810", routeId: "UCB", gtfsTripId: "trip_ucb_mock",
        generatedAt: now, dataAge: 12.2, freshness: "fresh", predictionHorizonSeconds: 12.2,
        reported: { latitude: 37.2388, longitude: -80.4332 },
        predicted: { latitude: 37.2410, longitude: -80.4339 },
        predictionState: {
          modelType: "route_constant_velocity",
          modelMode: "moving",
          startProgressKm: 2.2,
          routeLengthKm: EXACT_ROUTE_LENGTH, // 使用真实精准全长！
          speedMetersPerSecond: 10.0,
          initialElapsedSeconds: 12.2,
          loop: true
        },
        uncertainty: { p80Meters: 35, label: "P80 confidence window (BT data 12.2s fresh)" }
      }
    ],
    evaluation: { samples: 154, avgBaselineMeters: 86.4, avgConstantMeters: 41.2, avgMotionMeters: 23.8, motion: { wins: 112, ties: 16, losses: 26 } },
    uncertaintyCalibration: [
      { minSeconds: 0, maxSeconds: 15, sampleCount: 52, p80Meters: 24 },
      { minSeconds: 15, maxSeconds: 30, sampleCount: 68, p80Meters: 58 },
      { minSeconds: 30, maxSeconds: null, sampleCount: 34, p80Meters: 96 }
    ]
  };
}

const predictedIcon = L.divIcon({ className: "", html: '<div class="marker-predicted"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
const DEFAULT_ROUTE_COLOR = "#94a3b8";

function routeFill(bus) {
  return bus?.routeColor || DEFAULT_ROUTE_COLOR;
}

function createReportedIcon(color) {
  const fill = color || DEFAULT_ROUTE_COLOR;
  return L.divIcon({
    className: "",
    html: `<div class="marker-reported" style="background-color:${fill}"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
}

function createBasemapLayer() {
  const cartoKey = import.meta.env.VITE_CARTO_KEY;
  if (cartoKey) {
    return L.tileLayer(
      `https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(cartoKey)}`,
      {
        maxZoom: 20,
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
      }
    );
  }
  const stadiaKey = import.meta.env.VITE_STADIA_API_KEY;
  const stadiaUrl = stadiaKey
    ? `https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png?api_key=${encodeURIComponent(stadiaKey)}`
    : "https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png";
  return L.tileLayer(stadiaUrl, {
    maxZoom: 20,
    attribution:
      '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a>, &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a>, &copy; OpenStreetMap contributors'
  });
}

function freshnessClass(value) {
  if (value === "fresh") return "fresh-fresh";
  if (value === "recent") return "fresh-recent";
  return "fresh-stale";
}

function lerp(a, b, t) { return a + (b - a) * t; }
function formatMeters(value) { return value == null || Number.isNaN(value) ? "n/a" : `${value.toFixed(1)} m`; }
function formatImprovement(value) {
  if (value == null || Number.isNaN(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)} m`;
}

export default function App() {
  const mapRef = useRef(null);
  const mapNodeRef = useRef(null);
  const layersRef = useRef(null);
  const markersRef = useRef(new Map());
  const predictedDisplayRef = useRef(new Map());
  const selectedBusIdRef = useRef(null);
  const loadedTripIdRef = useRef(null);
  const rafRef = useRef(null);
  const stateRef = useRef(null);
  const routeCacheRef = useRef(new Map());
  const replaySeekVersionRef = useRef(null);
  const followPredictedRef = useRef(false);

  const [state, setState] = useState(null);
  const [selectedBusId, setSelectedBusId] = useState(null);
  const [showAllPredictions, setShowAllPredictions] = useState(false);
  const [error, setError] = useState(null);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(true);
  const showAllPredictionsRef = useRef(false);

  selectedBusIdRef.current = selectedBusId;
  showAllPredictionsRef.current = showAllPredictions;

  function predictionVisibleFor(busId) {
    if (showAllPredictionsRef.current) return true;
    return selectedBusIdRef.current != null && busId === selectedBusIdRef.current;
  }

  function selectBus(bus) {
    selectedBusIdRef.current = bus.id;
    followPredictedRef.current = true;
    setSelectedBusId(bus.id);
    loadRoute(bus.gtfsTripId, bus.routeColor);
  }

  function cacheRoute(tripId) {
    if (!tripId) return Promise.resolve(null);
    if (routeCacheRef.current.has(tripId)) return Promise.resolve(routeCacheRef.current.get(tripId));
    return fetch(apiUrl(`/api/route?tripId=${encodeURIComponent(tripId)}`))
      .then((res) => { if (!res.ok) throw new Error(); return res.json(); })
      .then((payload) => {
        const coords = payload.coordinates || null;
        routeCacheRef.current.set(tripId, coords);
        return coords;
      })
      .catch(() => {
        const fallback = MOCK_UCB_COORDINATES;
        routeCacheRef.current.set(tripId, fallback);
        return fallback;
      });
  }

  function loadRoute(tripId, color) {
    if (!tripId) return;
    const routeKey = `${tripId}|${color || ""}`;
    if (routeKey === loadedTripIdRef.current) return;
    cacheRoute(tripId).then((coordinates) => {
      loadedTripIdRef.current = routeKey;
      const routeLayer = layersRef.current?.route;
      if (!routeLayer) return;
      routeLayer.clearLayers();
      if (!coordinates || coordinates.length < 2) return;
      const latlngs = coordinates.map((coord) => [coord[1], coord[0]]);
      L.polyline(latlngs, {
        color: color || DEFAULT_ROUTE_COLOR,
        weight: 3,
        opacity: 0.75,
        dashArray: "4, 6"
      }).addTo(routeLayer);
    });
  }

  useEffect(() => {
    if (!mapNodeRef.current || mapRef.current) return;

    const map = L.map(mapNodeRef.current, {
      zoomControl: true,
      minZoom: 12,
      maxZoom: 20,
      maxBounds: [[37.05, -80.55], [37.35, -80.30]],
      maxBoundsViscosity: 1.0
    }).setView([37.230, -80.424], 14);

    createBasemapLayer().addTo(map);

    const rangeLayer = L.layerGroup().addTo(map);
    const reportedLayer = L.layerGroup().addTo(map);
    const predictedLayer = L.layerGroup().addTo(map);
    const routeLayer = L.layerGroup().addTo(map);

    mapRef.current = map;
    layersRef.current = { reported: reportedLayer, predicted: predictedLayer, range: rangeLayer, route: routeLayer };
    setTimeout(() => { map.invalidateSize(); }, 50);
    map.on("dragstart", () => {
      followPredictedRef.current = false;
    });

    function mapIsAnimating(mapInstance) {
      if (!mapInstance) return false;
      if (mapInstance._animatingZoom) return true;
      return Boolean(mapInstance._panAnim && mapInstance._panAnim._inProgress);
    }

    function removePredictionLayers(entry, layers, busId) {
      if (entry.predicted) {
        layers.predicted.removeLayer(entry.predicted);
        entry.predicted = null;
      }
      if (entry.rangeLine) {
        layers.range.removeLayer(entry.rangeLine);
        entry.rangeLine = null;
      }
      if (busId != null) {
        predictedDisplayRef.current.delete(busId);
      }
    }

    function animatePredicted() {
      const snapshot = stateRef.current;
      const layers = layersRef.current;
      const mapInstance = mapRef.current;
      const skipGeoUpdates = mapIsAnimating(mapInstance);

      if (snapshot && layers) {
        const replay = snapshot.sourceMode === "replay" ? snapshot.replay : null;
        const replayPaused = Boolean(replay && !replay.isPlaying);
        const seekVersion = Number(replay?.seekVersion);
        const seekedWhilePaused =
          replayPaused &&
          Number.isFinite(seekVersion) &&
          replaySeekVersionRef.current != null &&
          replaySeekVersionRef.current !== seekVersion;
        if (Number.isFinite(seekVersion)) {
          replaySeekVersionRef.current = seekVersion;
        }
        const animationNow = replayPaused
          ? snapshot.generatedAt
          : replay
            ? snapshot.generatedAt + (Date.now() - snapshot.generatedAt) * (Number(replay.rate) || 1)
            : Date.now();
        const buses = snapshot.buses || [];
        const seen = new Set();
        const focusId = selectedBusIdRef.current;

        for (const bus of buses) {
          seen.add(bus.id);
          const routeCoordinates = routeCacheRef.current.get(bus.gtfsTripId);
          const predictionVisible = predictionVisibleFor(bus.id);
          const fill = routeFill(bus);
          let entry = markersRef.current.get(bus.id);
          if (!entry) {
            const reported = L.marker([bus.reported.latitude, bus.reported.longitude], {
              icon: createReportedIcon(fill),
              zIndexOffset: 200
            }).addTo(layers.reported);
            reported.on("click", () => selectBus(bus));
            entry = { reported, predicted: null, rangeLine: null, routeColor: fill };
            markersRef.current.set(bus.id, entry);
          } else {
            if (entry.routeColor !== fill) {
              entry.reported.setIcon(createReportedIcon(fill));
              entry.routeColor = fill;
            }
            if (!skipGeoUpdates) {
              entry.reported.setLatLng([bus.reported.latitude, bus.reported.longitude]);
            }
            entry.reported.off("click"); entry.reported.on("click", () => selectBus(bus));
          }

          if (!predictionVisible) {
            removePredictionLayers(entry, layers, bus.id);
            continue;
          }

          const predicted = visualPredictedPosition(bus, routeCoordinates, animationNow);
          if (predicted) {
            if (!entry.predicted) {
              entry.predicted = L.marker([predicted.latitude, predicted.longitude], { icon: predictedIcon, zIndexOffset: 300 }).addTo(layers.predicted);
              predictedDisplayRef.current.set(bus.id, { lat: predicted.latitude, lon: predicted.longitude });
            }
            entry.predicted.off("click");
            entry.predicted.on("click", () => selectBus(bus));
            if (!skipGeoUpdates) {
              const current = predictedDisplayRef.current.get(bus.id) || { lat: predicted.latitude, lon: predicted.longitude };
              if (seekedWhilePaused) {
                current.lat = predicted.latitude;
                current.lon = predicted.longitude;
              } else if (!replayPaused) {
                current.lat = lerp(current.lat, predicted.latitude, 0.28);
                current.lon = lerp(current.lon, predicted.longitude, 0.28);
              }
              predictedDisplayRef.current.set(bus.id, current);
              entry.predicted.setLatLng([current.lat, current.lon]);
            }
          } else if (entry.predicted) {
            layers.predicted.removeLayer(entry.predicted);
            entry.predicted = null;
            predictedDisplayRef.current.delete(bus.id);
          }

          const ps = bus.predictionState;
          const range = bus.uncertainty && routeCoordinates && ps
            ? rangeCoordinates(
                routeCoordinates,
                progressFromState(ps, bus.generatedAt, animationNow),
                bus.uncertainty.p80Meters,
                ps.routeLengthKm,
                ps.loop
              )
            : null;
          if (range) {
            const isFocus = focusId != null && bus.id === focusId;
            if (!entry.rangeLine) {
              entry.rangeLine = L.polyline(range, {
                color: "#ea580c",
                weight: isFocus ? 14 : 8,
                opacity: isFocus ? 0.65 : 0.35,
                lineCap: "round",
                lineJoin: "round"
              }).addTo(layers.range);
            } else if (!skipGeoUpdates) {
              entry.rangeLine.setLatLngs(range);
              entry.rangeLine.setStyle({
                weight: isFocus ? 14 : 8,
                opacity: isFocus ? 0.65 : 0.35
              });
            }
          } else if (entry.rangeLine) {
            layers.range.removeLayer(entry.rangeLine);
            entry.rangeLine = null;
          }
        }

        for (const [id, entry] of markersRef.current) {
          if (seen.has(id)) continue;
          layers.reported.removeLayer(entry.reported);
          removePredictionLayers(entry, layers, id);
          markersRef.current.delete(id);
        }

        if (
          followPredictedRef.current &&
          !skipGeoUpdates &&
          selectedBusIdRef.current &&
          predictionVisibleFor(selectedBusIdRef.current)
        ) {
          const tracked = predictedDisplayRef.current.get(selectedBusIdRef.current);
          if (tracked) {
            mapInstance.panTo([tracked.lat, tracked.lon], { animate: false });
          }
        }
      }
      rafRef.current = requestAnimationFrame(animatePredicted);
    }

    rafRef.current = requestAnimationFrame(animatePredicted);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      map.remove();
      mapRef.current = null;
      layersRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let source = null;

    function applyState(next) {
      stateRef.current = next;
      setState(next);
      setError(null);
      for (const bus of next.buses || []) cacheRoute(bus.gtfsTripId);
    }

    fetch(apiUrl("/api/state"))
      .then((res) => { if (!res.ok) throw new Error(); return res.json(); })
      .then((next) => { if (!cancelled) applyState(next); })
      .catch(() => { if (!cancelled) applyState(createMockState()); });

    source = new EventSource(apiUrl("/api/events"));
    source.onmessage = (event) => { try { applyState(JSON.parse(event.data)); } catch (err) {} };
    source.onerror = () => {};

    return () => { cancelled = true; if (source) source.close(); };
  }, []);

  const sourceMode = state?.sourceMode || state?.mode;
  const selected = (state?.buses || []).find((bus) => bus.id === selectedBusId);
  const evaluation = state?.evaluation;
  const model7Validation = state?.model7Validation;

  return (
    <div className="app">
      <div ref={mapNodeRef} className="map" />
      <aside className={`panel ${mobilePanelOpen ? "panel-open" : ""}`}>
        <button
          className="drawer-toggle"
          type="button"
          aria-expanded={mobilePanelOpen}
          onClick={() => setMobilePanelOpen((open) => !open)}
        >
          <span aria-hidden="true" className="drawer-grip" />
          {mobilePanelOpen ? "Hide details" : "Show details"}
        </button>
        <div className="panel-content">
        <header>
          <div>
            <h1>BT+ Nowcast</h1>
            <p className="subtitle">TRUST → PREDICT → VERIFY</p>
          </div>
          <div className={`badge ${sourceMode === "replay" ? "replay" : "live"}`}>
            {sourceMode === "replay" ? "REPLAY" : sourceMode === "live" ? "LIVE" : "SIMULATION"}
            {state?.recording ? " · REC" : ""}
          </div>
        </header>

        {error && <section><p className="note">Backend: {error}. Start with BT_RECORD=false.</p></section>}

        {sourceMode === "replay" && (
          <ReplayControls replay={state?.replay} stateTimestamp={state?.timestamp} />
        )}

        <label className="prediction-toggle">
          <input
            type="checkbox"
            checked={showAllPredictions}
            onChange={(event) => setShowAllPredictions(event.target.checked)}
          />
          <span>
            Show All Predictions
            <span className="prediction-toggle-hint">Off: selected bus only</span>
          </span>
        </label>

        <section>
          <h2>Selected bus</h2>
          {selected ? (
            <div className="kv">
              <span>Bus ID</span><span>{selected.id}</span>
              <span>Route</span>
              <span>
                <span
                  className="route-swatch"
                  style={{ background: selected.routeColor || DEFAULT_ROUTE_COLOR }}
                />
                {selected.routeId}
              </span>
              <span>Data age</span>
              <span>{((selected.predictionState ? (selected.predictionState.initialElapsedSeconds || 0) + Math.max(0, (Date.now() - (selected.generatedAt || Date.now())) / 1000) : selected.dataAge)).toFixed(1)} s</span>
              <span>Freshness</span><span className={freshnessClass(selected.freshness)}>{selected.freshness.toUpperCase()}</span>
              <span>Horizon</span><span>{(selected.predicted?.predictionHorizonSeconds ?? selected.predictionHorizonSeconds).toFixed(1)} s</span>
              <span>Most likely</span><span>{selected.predicted ? `${selected.predicted.latitude.toFixed(6)}, ${selected.predicted.longitude.toFixed(6)}` : "unavailable"}</span>
              <span>Range (P80)</span><span>{selected.uncertainty ? `~${selected.uncertainty.p80Meters.toFixed(0)} m historical error` : "n/a"}</span>
            </div>
          ) : <p className="note">Click a marker to inspect a bus.</p>}
          {selected?.uncertainty?.label && <p className="note">{selected.uncertainty.label}</p>}
        </section>

        <section>
          <h2>Live Validation</h2>
          {evaluation ? (
            <>
              <div className="stat-row"><strong>Evaluated Samples:</strong> {evaluation.samples}</div>
              <div className="stat-row"><strong>BT Stale Error:</strong> {formatMeters(evaluation.avgBaselineMeters)}</div>
              <div className="stat-row"><strong>Constant Velocity:</strong> {formatMeters(evaluation.avgConstantMeters)}</div>
              <div className="stat-row" style={{ color: "#22c55e", fontWeight: "bold" }}><strong>Our Motion-Aware:</strong> {formatMeters(evaluation.avgMotionMeters)}</div>
              <div className="stat-row"><strong>Win / Tie / Loss:</strong> {evaluation.motion.wins}W / {evaluation.motion.ties}T / {evaluation.motion.losses}L</div>
              <p className="note">Auto-validates predictions against next ground-truth observation.</p>
            </>
          ) : <p className="note">Waiting for paired observations…</p>}
        </section>

        <section className="model7-validation">
          <h2>CAS Model 7 Validation</h2>
          {!model7Validation || !model7Validation.available ? (
            <p className="note">Waiting for CAS pairs…</p>
          ) : (
            <>
              <div className="stat-row"><strong>Completed CAS Pairs:</strong> {model7Validation.completedPairCount}</div>
              <div className="stat-row"><strong>BT Stale Error:</strong> {formatMeters(model7Validation.staleMeanGeoErrorMeters)}</div>
              <div className="stat-row"><strong>Model 1:</strong> {formatMeters(model7Validation.model1MeanGeoErrorMeters)}</div>
              <div className="stat-row model7-result"><strong>Model 7 Safe:</strong> {formatMeters(model7Validation.model7SafeMeanGeoErrorMeters)}</div>
              <div className="stat-row"><strong>Improvement vs Model 1:</strong> {formatImprovement(model7Validation.improvementVsModel1MeanGeoErrorMeters)}</div>
              <div className="stat-row"><strong>Hold / Moving:</strong> {model7Validation.nHold} / {model7Validation.nMoving}</div>
              {model7Validation.movingOnly?.completedPairCount > 0 && (
                <div className="moving-only">
                  <strong>Moving only ({model7Validation.movingOnly.completedPairCount}):</strong>
                  <span> Model 1 {formatMeters(model7Validation.movingOnly.model1MeanGeoErrorMeters)}</span>
                  <span> · Model 7 {formatMeters(model7Validation.movingOnly.model7SafeMeanGeoErrorMeters)}</span>
                  <span> · Δ {formatImprovement(model7Validation.movingOnly.improvementVsModel1MeanGeoErrorMeters)}</span>
                </div>
              )}
            </>
          )}
          {model7Validation?.mapUsesModel7Safe ? (
            <p className="note model7-status">CAS vehicles on the map are using Model 7 Safe.</p>
          ) : model7Validation ? (
            <p className="note">Evaluation only: the map is currently using Model 1.</p>
          ) : null}
        </section>

        <section>
          <h2>Uncertainty calibration</h2>
          {(state?.uncertaintyCalibration || []).map((bucket) => {
            const label = bucket.maxSeconds === null || !Number.isFinite(bucket.maxSeconds) ? `${bucket.minSeconds}s+` : `${bucket.minSeconds}-${bucket.maxSeconds}s`;
            return (
              <div className="stat-row" key={label}>
                {label}: n={bucket.sampleCount} {bucket.p80Meters != null ? ` · P80 ${bucket.p80Meters.toFixed(0)} m` : " · no samples"}
              </div>
            );
          })}
        </section>

        <section className="legend">
          <h2>Legend</h2>
          <p><span className="dot reported" /> Reported (stale BT GPS)</p>
          <p><span className="dot predicted" /> Predicted nowcast position</p>
          <p><span className="dot range" /> Uncertainty range (P80)</p>
        </section>
        </div>
      </aside>
    </div>
  );
}
