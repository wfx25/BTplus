import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";
import {
  progressFromState,
  rangeCoordinates,
  visualPredictedPosition
} from "./predictionPlayback.js";

const reportedIcon = L.divIcon({
  className: "",
  html: '<div class="marker-reported"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9]
});

const predictedIcon = L.divIcon({
  className: "",
  html: '<div class="marker-predicted"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11]
});

function freshnessClass(value) {
  if (value === "fresh") return "fresh-fresh";
  if (value === "recent") return "fresh-recent";
  return "fresh-stale";
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function formatMeters(value) {
  if (value == null || Number.isNaN(value)) return "n/a";
  return `${value.toFixed(1)} m`;
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

  const [state, setState] = useState(null);
  const [selectedBusId, setSelectedBusId] = useState(null);
  const [error, setError] = useState(null);

  selectedBusIdRef.current = selectedBusId;

  function selectBus(bus) {
    setSelectedBusId(bus.id);
    loadRoute(bus.gtfsTripId);
    const map = mapRef.current;
    const target = bus.predicted || bus.reported;
    if (map && target) {
      map.flyTo(
        [target.latitude, target.longitude],
        Math.max(map.getZoom(), 16),
        { duration: 0.45 }
      );
    }
  }

  function cacheRoute(tripId) {
    if (!tripId) {
      return Promise.resolve(null);
    }
    if (routeCacheRef.current.has(tripId)) {
      return Promise.resolve(routeCacheRef.current.get(tripId));
    }
    return fetch(`/api/route?tripId=${encodeURIComponent(tripId)}`)
      .then((response) => response.json())
      .then((payload) => {
        routeCacheRef.current.set(tripId, payload.coordinates || null);
        return payload.coordinates || null;
      })
      .catch(() => null);
  }

  function loadRoute(tripId) {
    if (!tripId || tripId === loadedTripIdRef.current) {
      return;
    }
    cacheRoute(tripId).then((coordinates) => {
      loadedTripIdRef.current = tripId;
      const routeLayer = layersRef.current?.route;
      if (!routeLayer) return;
      routeLayer.clearLayers();
      if (!coordinates || coordinates.length < 2) {
        return;
      }
      const latlngs = coordinates.map((coord) => [coord[1], coord[0]]);
      L.polyline(latlngs, {
        color: "#94a3b8",
        weight: 2,
        opacity: 0.55
      }).addTo(routeLayer);
    });
  }

  useEffect(() => {
    if (!mapNodeRef.current || mapRef.current) {
      return;
    }

    const map = L.map(mapNodeRef.current, {
      zoomControl: true
    }).setView([37.229, -80.42], 14);

    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 16,
        attribution: "Tiles &copy; Esri"
      }
    ).addTo(map);

    map.createPane("rangePane");
    map.getPane("rangePane").style.zIndex = 350;

    const rangeLayer = L.layerGroup({ pane: "rangePane" }).addTo(map);
    const reportedLayer = L.layerGroup().addTo(map);
    const predictedLayer = L.layerGroup().addTo(map);
    const routeLayer = L.layerGroup().addTo(map);

    mapRef.current = map;
    layersRef.current = {
      reported: reportedLayer,
      predicted: predictedLayer,
      range: rangeLayer,
      route: routeLayer
    };
    setTimeout(() => map.invalidateSize(), 50);

    function animatePredicted() {
      const snapshot = stateRef.current;
      const layers = layersRef.current;
      if (snapshot && layers) {
        const now = Date.now();
        const buses = snapshot.buses || [];
        const seen = new Set();
        for (const bus of buses) {
          seen.add(bus.id);
          const routeCoordinates = routeCacheRef.current.get(bus.gtfsTripId);
          const predicted = visualPredictedPosition(bus, routeCoordinates, now);
          let entry = markersRef.current.get(bus.id);
          if (!entry) {
            const reported = L.marker(
              [bus.reported.latitude, bus.reported.longitude],
              {
                icon: reportedIcon,
                zIndexOffset: 200,
                title: `reported ${bus.id}`
              }
            ).addTo(layers.reported);
            reported.on("click", () => selectBus(bus));
            const predictedMarker = predicted
              ? L.marker([predicted.latitude, predicted.longitude], {
                  icon: predictedIcon,
                  zIndexOffset: 300,
                  title: `predicted ${bus.id}`
                }).addTo(layers.predicted)
              : null;
            if (predictedMarker) {
              predictedMarker.on("click", () => selectBus(bus));
            }
            entry = { reported, predicted: predictedMarker };
            markersRef.current.set(bus.id, entry);
            if (predicted) {
              predictedDisplayRef.current.set(bus.id, {
                lat: predicted.latitude,
                lon: predicted.longitude
              });
            }
          } else {
            entry.reported.setLatLng([
              bus.reported.latitude,
              bus.reported.longitude
            ]);
            entry.reported.off("click");
            entry.reported.on("click", () => selectBus(bus));
            if (predicted) {
              if (!entry.predicted) {
                entry.predicted = L.marker(
                  [predicted.latitude, predicted.longitude],
                  {
                    icon: predictedIcon,
                    zIndexOffset: 300,
                    title: `predicted ${bus.id}`
                  }
                ).addTo(layers.predicted);
              }
              entry.predicted.off("click");
              entry.predicted.on("click", () => selectBus(bus));
              const current = predictedDisplayRef.current.get(bus.id) || {
                lat: predicted.latitude,
                lon: predicted.longitude
              };
              current.lat = lerp(current.lat, predicted.latitude, 0.28);
              current.lon = lerp(current.lon, predicted.longitude, 0.28);
              predictedDisplayRef.current.set(bus.id, current);
              entry.predicted.setLatLng([current.lat, current.lon]);
            } else if (entry.predicted) {
              layers.predicted.removeLayer(entry.predicted);
              entry.predicted = null;
              predictedDisplayRef.current.delete(bus.id);
            }
          }
        }

        for (const [id, entry] of markersRef.current) {
          if (seen.has(id)) continue;
          layers.reported.removeLayer(entry.reported);
          if (entry.predicted) layers.predicted.removeLayer(entry.predicted);
          markersRef.current.delete(id);
          predictedDisplayRef.current.delete(id);
        }

        layers.range.clearLayers();
        const focusId = selectedBusIdRef.current;
        for (const bus of buses) {
          const ps = bus.predictionState;
          const routeCoordinates = routeCacheRef.current.get(bus.gtfsTripId);
          if (!bus.uncertainty || !routeCoordinates || !ps) continue;
          const progressKm = progressFromState(ps, bus.generatedAt, now);
          const range = rangeCoordinates(
            routeCoordinates,
            progressKm,
            bus.uncertainty.p80Meters,
            ps.routeLengthKm,
            ps.loop
          );
          if (!range) continue;
          const isFocus = focusId != null && bus.id === focusId;
          L.polyline(range, {
            pane: "rangePane",
            color: "#ea580c",
            weight: isFocus ? 14 : 8,
            opacity: isFocus ? 0.55 : 0.28,
            lineCap: "round",
            lineJoin: "round"
          }).addTo(layers.range);
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
      for (const bus of next.buses || []) {
        cacheRoute(bus.gtfsTripId);
      }
    }

    fetch("/api/state")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((next) => {
        if (!cancelled) applyState(next);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || "Failed to load /api/state");
        }
      });

    source = new EventSource("/api/events");
    source.onmessage = (event) => {
      try {
        applyState(JSON.parse(event.data));
      } catch (err) {
        console.error(err);
      }
    };
    source.onerror = () => {
      if (!cancelled && source.readyState === EventSource.CLOSED) {
        setError("Lost live prediction stream");
      }
    };

    return () => {
      cancelled = true;
      if (source) source.close();
    };
  }, []);

  const sourceMode = state?.sourceMode || state?.mode;
  const selected = (state?.buses || []).find((bus) => bus.id === selectedBusId);
  const evaluation = state?.evaluation;

  return (
    <div className="app">
      <div ref={mapNodeRef} className="map" />
      <aside className="panel">
        <header>
          <div>
            <h1>BT+ Nowcast</h1>
            <p className="subtitle">TRUST → PREDICT → VERIFY</p>
          </div>
          <div className={`badge ${sourceMode === "replay" ? "replay" : "live"}`}>
            {sourceMode === "replay" ? "REPLAY" : sourceMode === "live" ? "LIVE" : "…"}
            {state?.recording ? " · REC" : ""}
          </div>
        </header>

        {error && (
          <section>
            <p className="note">Backend: {error}. Start with BT_RECORD=false.</p>
          </section>
        )}

        <section>
          <h2>Selected bus</h2>
          {selected ? (
            <div className="kv">
              <span>Bus ID</span>
              <span>{selected.id}</span>
              <span>Route</span>
              <span>{selected.routeId}</span>
              <span>Data age</span>
              <span>
                {(
                  (selected.predictionState
                    ? (selected.predictionState.initialElapsedSeconds || 0) +
                      Math.max(
                        0,
                        (Date.now() - (selected.generatedAt || Date.now())) / 1000
                      )
                    : selected.dataAge)
                ).toFixed(1)}{" "}
                s
              </span>
              <span>Freshness</span>
              <span className={freshnessClass(selected.freshness)}>
                {selected.freshness}
              </span>
              <span>Horizon</span>
              <span>
                {(
                  selected.predicted?.predictionHorizonSeconds ??
                  selected.predictionHorizonSeconds
                ).toFixed(1)}{" "}
                s
              </span>
              <span>Most likely</span>
              <span>
                {selected.predicted
                  ? `${selected.predicted.latitude.toFixed(6)}, ${selected.predicted.longitude.toFixed(6)}`
                  : "unavailable"}
              </span>
              <span>Range (P80)</span>
              <span>
                {selected.uncertainty
                  ? `~${selected.uncertainty.p80Meters.toFixed(0)} m historical error`
                  : "n/a"}
              </span>
            </div>
          ) : (
            <p className="note">Click a marker to inspect a bus.</p>
          )}
          {selected?.uncertainty?.label && (
            <p className="note">{selected.uncertainty.label}</p>
          )}
        </section>

        <section>
          <h2>Validation</h2>
          {evaluation ? (
            <>
              <div className="stat-row">Samples: {evaluation.samples}</div>
              <div className="stat-row">
                Baseline: {formatMeters(evaluation.avgBaselineMeters)}
              </div>
              <div className="stat-row">
                Constant velocity: {formatMeters(evaluation.avgConstantMeters)}
              </div>
              <div className="stat-row">
                Motion-aware: {formatMeters(evaluation.avgMotionMeters)}
              </div>
              <div className="stat-row">
                Motion W/T/L: {evaluation.motion.wins}/{evaluation.motion.ties}/
                {evaluation.motion.losses}
              </div>
              <p className="note">
                Speed oracle stays evaluation-only and is not shown as a live
                prediction.
              </p>
            </>
          ) : (
            <p className="note">Waiting for paired observations…</p>
          )}
        </section>

        <section>
          <h2>Uncertainty calibration</h2>
          {(state?.uncertaintyCalibration || []).map((bucket) => {
            const label =
              bucket.maxSeconds === null || !Number.isFinite(bucket.maxSeconds)
                ? `${bucket.minSeconds}s+`
                : `${bucket.minSeconds}-${bucket.maxSeconds}s`;
            return (
              <div className="stat-row" key={label}>
                {label}: n={bucket.sampleCount}
                {bucket.p80Meters != null
                  ? ` · P80 ${bucket.p80Meters.toFixed(0)} m`
                  : " · no samples"}
              </div>
            );
          })}
        </section>

        <section className="legend">
          <h2>Legend</h2>
          <p>
            <span className="dot reported" /> Reported (raw BT)
          </p>
          <p>
            <span className="dot predicted" /> Most likely predicted position
          </p>
          <p>
            <span className="dot range" /> Route-aligned prediction range (P80, not a CI)
          </p>
        </section>
      </aside>
    </div>
  );
}
