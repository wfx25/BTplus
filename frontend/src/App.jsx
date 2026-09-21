import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";
import {
  progressFromState,
  rangeCoordinates,
  usableRouteCoordinates,
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
        predictionState: { modelType: "route_constant_velocity", modelMode: "moving", startProgressKm: 0.65, routeLengthKm: EXACT_ROUTE_LENGTH, speedMetersPerSecond: 8.5, initialElapsedSeconds: 24.8, loop: true },
        uncertainty: { p80Meters: 70, label: "P80 confidence window (BT data 24.8s stale)" }
      },
      {
        id: "5810", routeId: "UCB", gtfsTripId: "trip_ucb_mock",
        generatedAt: now, dataAge: 12.2, freshness: "fresh", predictionHorizonSeconds: 12.2,
        reported: { latitude: 37.2388, longitude: -80.4332 },
        predicted: { latitude: 37.2410, longitude: -80.4339 },
        predictionState: { modelType: "route_constant_velocity", modelMode: "moving", startProgressKm: 2.2, routeLengthKm: EXACT_ROUTE_LENGTH, speedMetersPerSecond: 10.0, initialElapsedSeconds: 12.2, loop: true },
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

// === BT 官方 GTFS 权威全量路线配色表 (来自官方 routes.txt) ===
const BT_ROUTE_COLORS = {
  HWA: "#1A4882", HWB: "#0098D4", HWC: "#7156A5", HWS: "#7156A5",
  TCR: "#EE7C0E", TCP: "#EE7C0E", TOM: "#EE7C0E",
  TTH: "#87012D", TTS: "#EE7C0E", TTT: "#EE7C0E",
  HXP: "#00A4A7", HXS: "#00A4A7",
  PHD: "#FF69B4", PHB: "#00782A",
  SMA: "#84B817", SME: "#0098D4", SMS: "#0098D4",
  UCB: "#84B817", CAS: "#302F2F", CRC: "#00782A", CRB: "#E32017",
  NMG: "#E32017", NMS: "#E32017", PRG: "#7156A5", HDG: "#874901",
  BMR: "#FF69B4", BMW: "#FF69B4", BLU: "#0000FF", GRN: "#84B817"
};

function getRouteColor(routeId, backendColor) {
  if (backendColor) return backendColor;
  if (!routeId) return "#E87722";
  const id = routeId.toUpperCase();
  if (BT_ROUTE_COLORS[id]) return BT_ROUTE_COLORS[id];
  const fallbackPalette = ["#06B6D4", "#8B5CF6", "#F59E0B", "#10B981", "#EC4899", "#3B82F6", "#F97316"];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return fallbackPalette[Math.abs(hash) % fallbackPalette.length];
}

function getReportedIcon(color) {
  return L.divIcon({
    className: "",
    html: `<div class="marker-reported" style="background-color: ${color};"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });
}

function getPredictedIcon(color) {
  return L.divIcon({
    className: "",
    html: `<div class="marker-predicted" style="--route-color: ${color};"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });
}

// === Tom 移植：Stadia Maps Alidade Smooth 顶级雅致底图生成器 ===
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

function resolveCachedRoute(cached) {
  if (cached && typeof cached.then === "function") return null;
  return usableRouteCoordinates(cached);
}

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

  const isTrackingRef = useRef(false);
  const isFlyingRef = useRef(false);

  const [state, setState] = useState(null);
  const [selectedBusId, setSelectedBusId] = useState(null);
  const [showAllPredictions, setShowAllPredictions] = useState(false);
  const [error, setError] = useState(null);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(true);
  const showAllPredictionsRef = useRef(false);

  // === 控制设置项 ===
  const [routeAnimated, setRouteAnimated] = useState(false);
  const routeAnimatedRef = useRef(false);
  const [isTrackingUI, setIsTrackingUI] = useState(false);
  
  const [useRouteColor, setUseRouteColor] = useState(true);
  const useRouteColorRef = useRef(true);

  const [useRouteLineColor, setUseRouteLineColor] = useState(false);
  const useRouteLineColorRef = useRef(false);

  function toggleRouteLineColor(checked) {
    setUseRouteLineColor(checked);
    useRouteLineColorRef.current = checked;
    if (selectedBusIdRef.current && stateRef.current) {
      const bus = stateRef.current.buses.find((b) => b.id === selectedBusIdRef.current);
      if (bus) loadRoute(bus.gtfsTripId, true, bus.routeId, bus.reported);
    }
  }

  // === 控制折叠状态 ===
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [settingsCollapsed, setSettingsCollapsed] = useState(false);

  selectedBusIdRef.current = selectedBusId;
  showAllPredictionsRef.current = showAllPredictions;

  function predictionVisibleFor(busId) {
    if (showAllPredictionsRef.current) return true;
    return selectedBusIdRef.current != null && busId === selectedBusIdRef.current;
  }

  useEffect(() => {
    if (mapRef.current) {
      setTimeout(() => {
        mapRef.current.invalidateSize();
      }, 360);
    }
  }, [panelCollapsed, mobilePanelOpen]);

  function toggleRouteAnimation(checked) {
    setRouteAnimated(checked);
    routeAnimatedRef.current = checked;
    if (selectedBusIdRef.current && stateRef.current) {
      const bus = stateRef.current.buses.find((b) => b.id === selectedBusIdRef.current);
      if (bus) loadRoute(bus.gtfsTripId, true, bus.routeId, bus.reported);
    }
  }

  function selectBus(bus) {
    selectedBusIdRef.current = bus.id;
    followPredictedRef.current = true;
    setSelectedBusId(bus.id);
    isTrackingRef.current = true;
    setIsTrackingUI(true);

    loadRoute(bus.gtfsTripId, false, bus.routeId, bus.reported);
    const map = mapRef.current;
    const target = bus.predicted || bus.reported;
    if (map && target) {
      map.panTo([target.latitude, target.longitude], { animate: false });
    }
  }

  function clearSelection() {
    selectedBusIdRef.current = null;
    followPredictedRef.current = false;
    isTrackingRef.current = false;
    setSelectedBusId(null);
    setIsTrackingUI(false);
    loadedTripIdRef.current = null;
    layersRef.current?.route?.clearLayers();
  }

  function cacheRoute(tripId, routeId, reported) {
    if (!tripId && !routeId) return Promise.resolve(null);
    const cacheKey = tripId || `route:${routeId}`;
    const cached = routeCacheRef.current.get(cacheKey);
    if (cached !== undefined) {
      if (cached && typeof cached.then === "function") return cached;
      return Promise.resolve(resolveCachedRoute(cached));
    }

    const params = new URLSearchParams();
    if (tripId) params.set("tripId", tripId);
    if (routeId) params.set("routeId", routeId);
    if (Number.isFinite(reported?.latitude)) params.set("lat", String(reported.latitude));
    if (Number.isFinite(reported?.longitude)) params.set("lon", String(reported.longitude));

    const request = fetch(apiUrl(`/api/route?${params.toString()}`))
      .then((res) => { if (!res.ok) throw new Error(); return res.json(); })
      .then((payload) => {
        const coords = usableRouteCoordinates(payload.coordinates);
        const resolved =
          coords || (tripId === "trip_ucb_mock" ? MOCK_UCB_COORDINATES : null);
        routeCacheRef.current.set(cacheKey, resolved);
        return resolved;
      })
      .catch(() => {
        const resolved = tripId === "trip_ucb_mock" ? MOCK_UCB_COORDINATES : null;
        if (resolved) {
          routeCacheRef.current.set(cacheKey, resolved);
        } else {
          routeCacheRef.current.delete(cacheKey);
        }
        return resolved;
      });

    routeCacheRef.current.set(cacheKey, request);
    return request;
  }

  function loadRoute(tripId, forceRedraw = false, routeId, reported) {
    if (!tripId && !routeId) return;
    const cacheKey = tripId || `route:${routeId}`;
    if (!forceRedraw && cacheKey === loadedTripIdRef.current) return;

    cacheRoute(tripId, routeId, reported).then((coordinates) => {
      loadedTripIdRef.current = cacheKey;
      const routeLayer = layersRef.current?.route;
      if (!routeLayer) return;
      routeLayer.clearLayers();
      if (!coordinates || coordinates.length < 2) return;
      const latlngs = coordinates.map((coord) => [coord[1], coord[0]]);

      let dynamicColor = "#861F41"; // 默认 VT Maroon 枣红
      if (useRouteLineColorRef.current && stateRef.current && selectedBusIdRef.current) {
        const selectedBus = stateRef.current.buses.find((b) => b.id === selectedBusIdRef.current);
        if (selectedBus) {
          dynamicColor = getRouteColor(selectedBus.routeId, selectedBus.routeColor);
        }
      }

      L.polyline(latlngs, {
        color: dynamicColor,
        weight: 4,
        opacity: 0.85,
        className: routeAnimatedRef.current ? "route-marching-ants" : ""
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

    const breakFollow = () => {
      if (isTrackingRef.current) {
        isTrackingRef.current = false;
        setIsTrackingUI(false);
      }
    };
    map.on("mousedown dragstart", breakFollow);
    map.getContainer().addEventListener("wheel", breakFollow);
    map.getContainer().addEventListener("touchstart", breakFollow);

    // 采用 Tom 的高级底图图层生成器！
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
      return Boolean(mapInstance && mapInstance._animatingZoom);
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
      if (entry.connector) {
        layers.range.removeLayer(entry.connector);
        entry.connector = null;
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
          const routeCoordinates = resolveCachedRoute(routeCacheRef.current.get(bus.gtfsTripId));
          const predictionVisible = predictionVisibleFor(bus.id);
          let predicted = predictionVisible
            ? visualPredictedPosition(bus, routeCoordinates, animationNow)
            : null;

          const busBaseColor = getRouteColor(bus.routeId, bus.routeColor);
          const desiredColor = useRouteColorRef.current ? busBaseColor : "#E87722";
          const isFocus = focusId != null && bus.id === focusId;

          let entry = markersRef.current.get(bus.id);
          if (!entry) {
            const reported = L.marker([bus.reported.latitude, bus.reported.longitude], {
              icon: getReportedIcon(busBaseColor),
              zIndexOffset: 200
            }).addTo(layers.reported);
            reported.on("click", () => selectBus(bus));
            const predictedMarker = predicted
              ? L.marker([predicted.latitude, predicted.longitude], {
                  icon: getPredictedIcon(desiredColor),
                  zIndexOffset: 300
                }).addTo(layers.predicted)
              : null;
            if (predictedMarker) {
              predictedMarker.on("click", () => selectBus(bus));
              predictedDisplayRef.current.set(bus.id, { lat: predicted.latitude, lon: predicted.longitude });
            }
            entry = {
              reported,
              predicted: predictedMarker,
              currentColor: desiredColor,
              currentBaseColor: busBaseColor,
              rangeLine: null,
              connector: null
            };
            markersRef.current.set(bus.id, entry);
          } else {
            if (entry.currentBaseColor !== busBaseColor) {
              entry.reported.setIcon(getReportedIcon(busBaseColor));
              entry.currentBaseColor = busBaseColor;
            }
            if (!skipGeoUpdates) {
              entry.reported.setLatLng([bus.reported.latitude, bus.reported.longitude]);
            }
            entry.reported.off("click");
            entry.reported.on("click", () => selectBus(bus));
            if (predicted) {
              if (!entry.predicted) {
                entry.predicted = L.marker([predicted.latitude, predicted.longitude], {
                  icon: getPredictedIcon(desiredColor),
                  zIndexOffset: 300
                }).addTo(layers.predicted);
                entry.currentColor = desiredColor;
                predictedDisplayRef.current.set(bus.id, { lat: predicted.latitude, lon: predicted.longitude });
              } else if (entry.currentColor !== desiredColor) {
                entry.predicted.setIcon(getPredictedIcon(desiredColor));
                entry.currentColor = desiredColor;
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
          }

          entry.reported.setOpacity(focusId != null && !isFocus ? 0.18 : 1);
          const tracked = predictedDisplayRef.current.get(bus.id);
          if (isFocus && tracked && bus.reported) {
            const link = [
              [bus.reported.latitude, bus.reported.longitude],
              [tracked.lat, tracked.lon]
            ];
            if (!entry.connector) {
              entry.connector = L.polyline(link, {
                color: "#1e293b",
                weight: 3,
                opacity: 1,
                dashArray: "8, 6",
                interactive: false
              }).addTo(layers.range);
            } else if (!skipGeoUpdates) {
              entry.connector.setLatLngs(link);
            }
          } else if (entry.connector) {
            layers.range.removeLayer(entry.connector);
            entry.connector = null;
          }
        }

        for (const bus of buses) {
          let entry = markersRef.current.get(bus.id);
          if (!entry) continue;

          if (focusId == null || bus.id !== focusId) {
            if (entry.rangeLine) {
              layers.range.removeLayer(entry.rangeLine);
              entry.rangeLine = null;
            }
            continue;
          }

          const ps = bus.predictionState;
          const routeCoordinates = resolveCachedRoute(routeCacheRef.current.get(bus.gtfsTripId));
          if (!bus.uncertainty || !routeCoordinates || !ps || ps.modelMode === "hold") {
            if (entry.rangeLine) {
              layers.range.removeLayer(entry.rangeLine);
              entry.rangeLine = null;
            }
            continue;
          }

          const progressKm = progressFromState(ps, bus.generatedAt, animationNow);
          const range = rangeCoordinates(routeCoordinates, progressKm, bus.uncertainty.p80Meters, ps.routeLengthKm, ps.loop);
          const busBaseColor = getRouteColor(bus.routeId, bus.routeColor);
          const desiredColor = useRouteColorRef.current ? busBaseColor : "#E87722";

          if (range) {
            if (!entry.rangeLine) {
              entry.rangeLine = L.polyline(range, {
                color: desiredColor,
                weight: 12,
                opacity: 0.65,
                lineCap: "round",
                lineJoin: "round"
              }).addTo(layers.range);
            } else if (!skipGeoUpdates) {
              entry.rangeLine.setLatLngs(range);
              entry.rangeLine.setStyle({ color: desiredColor });
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
          isTrackingRef.current &&
          !skipGeoUpdates &&
          selectedBusIdRef.current
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
      for (const bus of next.buses || []) {
        cacheRoute(bus.gtfsTripId, bus.routeId, bus.reported);
      }
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
      {/* 1. 地图区域 */}
      <div ref={mapNodeRef} className="map" />

      {selectedBusId != null && (
        <div className="clear-selection">
          <button type="button" onClick={clearSelection}>
            Clear selection
          </button>
        </div>
      )}

      {/* 2. 可折叠的地图悬浮控制胶囊 (左下角) */}
      <div className="map-settings-widget">
        <div
          className="map-settings-header"
          onClick={() => setSettingsCollapsed(!settingsCollapsed)}
        >
          <div className="map-settings-title">⚙️ Map Controls</div>
          <button className="widget-toggle-btn" type="button">
            {settingsCollapsed ? "▲" : "▼"}
          </button>
        </div>

        {!settingsCollapsed && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "4px" }}>
            <label>
              <input
                type="checkbox"
                checked={showAllPredictions}
                onChange={(e) => setShowAllPredictions(e.target.checked)}
              />
              Show All Predictions
            </label>
            <label>
              <input
                type="checkbox"
                checked={isTrackingUI}
                onChange={(e) => {
                  setIsTrackingUI(e.target.checked);
                  isTrackingRef.current = e.target.checked;
                }}
              />
              Follow Bus (Camera Lock)
            </label>
            <label>
              <input
                type="checkbox"
                checked={routeAnimated}
                onChange={(e) => toggleRouteAnimation(e.target.checked)}
              />
              Animate Route Flow
            </label>
            <label>
              <input
                type="checkbox"
                checked={useRouteColor}
                onChange={(e) => {
                  setUseRouteColor(e.target.checked);
                  useRouteColorRef.current = e.target.checked;
                }}
              />
              Route-Specific Prediction
            </label>
            <label>
              <input
                type="checkbox"
                checked={useRouteLineColor}
                onChange={(e) => toggleRouteLineColor(e.target.checked)}
              />
              Route-Specific Route Line
            </label>
          </div>
        )}
      </div>

      {/* 3. 具备一键平滑收起/展开功能的现代科技感侧边栏 */}
      <aside className={`panel ${panelCollapsed ? "collapsed" : ""} ${mobilePanelOpen ? "panel-open" : ""}`}>
        <button
          className="panel-dock-btn"
          type="button"
          onClick={() => setPanelCollapsed(!panelCollapsed)}
          title={panelCollapsed ? "Expand Dashboard" : "Collapse Dashboard"}
        >
          {panelCollapsed ? "◀" : "▶"}
        </button>

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

          {error && (
            <section>
              <p className="note">Backend: {error}. Start with BT_RECORD=false.</p>
            </section>
          )}

          {sourceMode === "replay" && (
            <ReplayControls replay={state?.replay} stateTimestamp={state?.timestamp} />
          )}

          <section>
            <h2>Selected bus</h2>
            {selected ? (
              <div className="kv">
                <span>Bus ID</span>
                <span>{selected.id}</span>
                <span>Route</span>
                <span
                  style={{
                    // 1. 保留原本官方的纯正路线颜色（CAS 依然是深黑炭灰色！）
                    color: getRouteColor(selected.routeId, selected.routeColor),
                    fontWeight: 900,
                    fontSize: "1.25rem",
                    letterSpacing: "0.08em",
                    // 2. 贴身白色文字描边（给字母笔画外圈包上纯白轮廓）
                    WebkitTextStroke: selected.routeId?.toUpperCase() === "CAS" ? "1.2px #ffffff" : "0.5px rgba(255, 255, 255, 0.4)",
                    paintOrder: "stroke fill", // 确保文字内部颜色不被描边吃掉
                    textShadow: "0 0 10px rgba(255, 255, 255, 0.3)" // 轮廓外微光
                  }}
                >
                  {selected.routeId}
                </span>

                <span>Data age</span>
                <span>
                  {Math.max(
                    0,
                    (selected.predictionState
                      ? (selected.predictionState.initialElapsedSeconds || 0) +
                        Math.max(0, (Date.now() - (selected.generatedAt || Date.now())) / 1000)
                      : selected.dataAge || 0)
                  ).toFixed(1)}{" "}
                  s
                </span>

                <span>Freshness</span>
                <span className={freshnessClass(selected.freshness)}>
                  {selected.freshness.toUpperCase()}
                </span>

                <span>Horizon</span>
                <span>
                  {Math.max(
                    0,
                    (selected.predicted?.predictionHorizonSeconds ??
                      selected.predictionHorizonSeconds ??
                      0)
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
            {selected?.uncertainty?.label && <p className="note">{selected.uncertainty.label}</p>}
          </section>

          <section>
            <h2>Live Validation</h2>
            {evaluation ? (
              <>
                <div className="stat-row">
                  <strong>Evaluated Samples:</strong> {evaluation.samples}
                </div>
                <div className="stat-row">
                  <strong>BT Stale Error:</strong> {formatMeters(evaluation.avgBaselineMeters)}
                </div>
                <div className="stat-row">
                  <strong>Constant Velocity:</strong> {formatMeters(evaluation.avgConstantMeters)}
                </div>
                <div className="stat-row" style={{ color: "#22c55e", fontWeight: "bold" }}>
                  <strong>Our Motion-Aware:</strong> {formatMeters(evaluation.avgMotionMeters)}
                </div>
                <div className="stat-row">
                  <strong>Win / Tie / Loss:</strong> {evaluation.motion.wins}W / {evaluation.motion.ties}T /{" "}
                  {evaluation.motion.losses}L
                </div>
                <p className="note">Auto-validates predictions against next ground-truth observation.</p>
              </>
            ) : (
              <p className="note">Waiting for paired observations…</p>
            )}
          </section>

          <section className="model7-validation">
            <h2>CAS Model 7 Validation</h2>
            {!model7Validation || !model7Validation.available ? (
              <p className="note">Waiting for CAS pairs…</p>
            ) : (
              <>
                <div className="stat-row">
                  <strong>Completed CAS Pairs:</strong> {model7Validation.completedPairCount}
                </div>
                <div className="stat-row">
                  <strong>BT Stale Error:</strong> {formatMeters(model7Validation.staleMeanGeoErrorMeters)}
                </div>
                <div className="stat-row">
                  <strong>Model 1:</strong> {formatMeters(model7Validation.model1MeanGeoErrorMeters)}
                </div>
                <div className="stat-row model7-result">
                  <strong>Model 7 Safe:</strong> {formatMeters(model7Validation.model7SafeMeanGeoErrorMeters)}
                </div>
                <div className="stat-row">
                  <strong>Improvement vs Model 1:</strong>{" "}
                  {formatImprovement(model7Validation.improvementVsModel1MeanGeoErrorMeters)}
                </div>
                <div className="stat-row">
                  <strong>Hold / Moving:</strong> {model7Validation.nHold} / {model7Validation.nMoving}
                </div>
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
                  {label}: n={bucket.sampleCount}{" "}
                  {bucket.p80Meters != null ? ` · P80 ${bucket.p80Meters.toFixed(0)} m` : " · no samples"}
                </div>
              );
            })}
          </section>

          <section className="legend">
            <h2>Legend</h2>
            <p>
              <span className="dot reported" /> Reported (stale BT GPS)
            </p>
            <p>
              <span className="dot predicted" /> Predicted nowcast position
            </p>
            <p>
              <span className="dot range" /> Uncertainty range (P80)
            </p>
            <p>
              <span className="dot connector" /> Selected: other reports faded + dashed link
            </p>
          </section>
        </div>
      </aside>
    </div>
  );
}