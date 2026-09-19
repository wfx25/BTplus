const map = L.map("map").setView([37.229, -80.42], 13);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap"
}).addTo(map);

const reportedLayer = L.layerGroup().addTo(map);
const predictedLayer = L.layerGroup().addTo(map);
const uncertaintyLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);

const busMarkers = new Map();
const predictedDisplay = new Map();
let selectedBusId = null;
let loadedTripId = null;
let lastState = null;

const reportedIcon = L.divIcon({
  className: "",
  html: '<div style="width:14px;height:14px;border:2px solid #f8fafc;border-radius:50%;background:transparent;box-shadow:0 0 0 1px #0f172a"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7]
});

const predictedIcon = L.divIcon({
  className: "",
  html: '<div style="width:14px;height:14px;border-radius:50%;background:#38bdf8;border:2px solid #0f172a"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7]
});

function freshnessClass(value) {
  if (value === "fresh") return "fresh-fresh";
  if (value === "recent") return "fresh-recent";
  return "fresh-stale";
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function selectBus(bus) {
  selectedBusId = bus.id;
  renderDetails(bus);
  loadRoute(bus.gtfsTripId);
}

function loadRoute(tripId) {
  if (!tripId || tripId === loadedTripId) {
    return;
  }

  fetch(`/api/route?tripId=${encodeURIComponent(tripId)}`)
    .then(response => response.json())
    .then(payload => {
      loadedTripId = tripId;
      routeLayer.clearLayers();
      if (!payload.coordinates || payload.coordinates.length < 2) {
        return;
      }
      const latlngs = payload.coordinates.map(coord => [coord[1], coord[0]]);
      L.polyline(latlngs, {
        color: "#64748b",
        weight: 3,
        opacity: 0.7
      }).addTo(routeLayer);
    })
    .catch(() => {});
}

function renderDetails(bus) {
  const el = document.getElementById("bus-details");
  if (!bus) {
    el.textContent = "Click a marker to inspect a bus.";
    return;
  }

  const predicted = bus.predicted
    ? `${bus.predicted.latitude.toFixed(6)}, ${bus.predicted.longitude.toFixed(6)} (${bus.predicted.modelMode})`
    : "unavailable";

  const nextStop = bus.nextStop
    ? `${bus.nextStop.stopName || bus.nextStop.stopId} (${bus.nextStop.distanceMeters.toFixed(0)} m, scheduled only)`
    : "none";

  const turn = bus.upcomingTurn
    ? `${bus.upcomingTurn.turnDirection} ${bus.upcomingTurn.turnAngleDegrees.toFixed(0)}° in ${bus.upcomingTurn.distanceToTurnMeters.toFixed(0)} m`
    : "none in lookahead";

  el.innerHTML = `
    <div class="kv">
      <span>Bus</span><span>${bus.id} · ${bus.routeId}</span>
      <span>Pattern</span><span>${bus.patternName || "—"}</span>
      <span>Freshness</span><span class="${freshnessClass(bus.freshness)}">${bus.freshness} (${bus.dataAge.toFixed(1)} s)</span>
      <span>Horizon</span><span>${bus.predictionHorizonSeconds.toFixed(1)} s</span>
      <span>Speed</span><span>${bus.speed.toFixed(1)} m/s</span>
      <span>Heading</span><span>${bus.direction.toFixed(0)}°</span>
      <span>At stop flag</span><span>${bus.isBusAtStop ? "true" : "false"}</span>
      <span>Reported</span><span>${bus.reported.latitude.toFixed(6)}, ${bus.reported.longitude.toFixed(6)}</span>
      <span>Predicted</span><span>${predicted}</span>
      <span>Uncertainty</span><span>P80 ${bus.uncertainty.p80Meters.toFixed(0)} m · ${bus.uncertainty.kind}</span>
      <span>Next stop</span><span>${nextStop}</span>
      <span>Upcoming turn</span><span>${turn} (diagnostic)</span>
    </div>
    <p class="note">${bus.uncertainty.label}</p>
  `;
}

function renderStats(evaluation) {
  const el = document.getElementById("eval-stats");
  if (!evaluation) {
    el.textContent = "Waiting for paired observations…";
    return;
  }

  el.innerHTML = `
    <div class="stat-row">Samples: ${evaluation.samples}</div>
    <div class="stat-row">Baseline: ${evaluation.avgBaselineMeters.toFixed(1)} m</div>
    <div class="stat-row">Constant velocity: ${evaluation.avgConstantMeters.toFixed(1)} m</div>
    <div class="stat-row">Motion-aware: ${evaluation.avgMotionMeters.toFixed(1)} m</div>
    <div class="stat-row">Motion W/T/L: ${evaluation.motion.wins}/${evaluation.motion.ties}/${evaluation.motion.losses}</div>
    <p class="note">Speed oracle stays evaluation-only and is not shown as a live prediction.</p>
  `;
}

function upsertMarkers(buses) {
  const seen = new Set();

  for (const bus of buses) {
    seen.add(bus.id);

    let entry = busMarkers.get(bus.id);
    if (!entry) {
      const reported = L.marker(
        [bus.reported.latitude, bus.reported.longitude],
        { icon: reportedIcon, zIndexOffset: 200 }
      ).addTo(reportedLayer);

      reported.on("click", () => selectBus(bus));

      const predicted = bus.predicted
        ? L.marker(
            [bus.predicted.latitude, bus.predicted.longitude],
            { icon: predictedIcon, zIndexOffset: 300 }
          ).addTo(predictedLayer)
        : null;

      if (predicted) {
        predicted.on("click", () => selectBus(bus));
      }

      entry = { reported, predicted };
      busMarkers.set(bus.id, entry);
    } else {
      entry.reported.setLatLng([
        bus.reported.latitude,
        bus.reported.longitude
      ]);
      entry.reported.off("click");
      entry.reported.on("click", () => selectBus(bus));

      if (bus.predicted) {
        if (!entry.predicted) {
          entry.predicted = L.marker(
            [bus.predicted.latitude, bus.predicted.longitude],
            { icon: predictedIcon, zIndexOffset: 300 }
          ).addTo(predictedLayer);
        }
        entry.predicted.off("click");
        entry.predicted.on("click", () => selectBus(bus));

        const current = predictedDisplay.get(bus.id) || {
          lat: bus.predicted.latitude,
          lon: bus.predicted.longitude
        };
        predictedDisplay.set(bus.id, {
          lat: current.lat,
          lon: current.lon,
          targetLat: bus.predicted.latitude,
          targetLon: bus.predicted.longitude
        });
      } else if (entry.predicted) {
        predictedLayer.removeLayer(entry.predicted);
        entry.predicted = null;
        predictedDisplay.delete(bus.id);
      }
    }

    if (bus.predicted && !predictedDisplay.has(bus.id)) {
      predictedDisplay.set(bus.id, {
        lat: bus.predicted.latitude,
        lon: bus.predicted.longitude,
        targetLat: bus.predicted.latitude,
        targetLon: bus.predicted.longitude
      });
    }
  }

  for (const [id, entry] of busMarkers) {
    if (seen.has(id)) continue;
    reportedLayer.removeLayer(entry.reported);
    if (entry.predicted) predictedLayer.removeLayer(entry.predicted);
    busMarkers.delete(id);
    predictedDisplay.delete(id);
  }
}

function drawUncertainty(buses) {
  uncertaintyLayer.clearLayers();
  const focus = selectedBusId
    ? buses.find(bus => bus.id === selectedBusId)
    : null;
  const targets = focus ? [focus] : buses.slice(0, 12);

  for (const bus of targets) {
    if (!bus.predicted || !bus.uncertainty) continue;

    if (
      bus.uncertainty.kind === "route_aligned" &&
      bus.uncertainty.routeCoordinates &&
      bus.uncertainty.routeCoordinates.length >= 2
    ) {
      const latlngs = bus.uncertainty.routeCoordinates.map(
        coord => [coord[1], coord[0]]
      );
      L.polyline(latlngs, {
        color: "#38bdf8",
        weight: 8,
        opacity: 0.28
      }).addTo(uncertaintyLayer);
    } else {
      L.circle(
        [bus.predicted.latitude, bus.predicted.longitude],
        {
          radius: bus.uncertainty.p80Meters,
          color: "#38bdf8",
          weight: 1,
          fillOpacity: 0.08
        }
      ).addTo(uncertaintyLayer);
    }
  }
}

function animatePredicted() {
  for (const [id, display] of predictedDisplay) {
    if (display.targetLat == null) continue;
    display.lat = lerp(display.lat, display.targetLat, 0.18);
    display.lon = lerp(display.lon, display.targetLon, 0.18);
    const entry = busMarkers.get(id);
    if (entry && entry.predicted) {
      entry.predicted.setLatLng([display.lat, display.lon]);
    }
  }
  requestAnimationFrame(animatePredicted);
}

async function pollState() {
  try {
    const response = await fetch("/api/state");
    const state = await response.json();
    lastState = state;

    const badge = document.getElementById("mode-badge");
    badge.textContent = state.mode === "replay" ? "REPLAY" : "LIVE";
    badge.className = `badge ${state.mode === "replay" ? "replay" : "live"}`;
    if (state.recording) {
      badge.textContent += " · REC";
    }

    upsertMarkers(state.buses || []);
    drawUncertainty(state.buses || []);
    renderStats(state.evaluation);

    if (selectedBusId) {
      const selected = (state.buses || []).find(bus => bus.id === selectedBusId);
      renderDetails(selected || null);
    }
  } catch (error) {
    console.error("Failed to load /api/state", error);
  }
}

animatePredicted();
pollState();
setInterval(pollState, 1500);
