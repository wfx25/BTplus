export function normalizeProgressKm(progressKm, routeLengthKm, loop) {
  if (progressKm == null || !Number.isFinite(progressKm)) {
    return null;
  }
  if (!routeLengthKm || routeLengthKm <= 0) {
    return progressKm;
  }
  if (loop) {
    return ((progressKm % routeLengthKm) + routeLengthKm) % routeLengthKm;
  }
  return Math.max(0, Math.min(progressKm, routeLengthKm));
}

export function elapsedSeconds(predictionState, generatedAt, nowMs = Date.now()) {
  const initial = predictionState?.initialElapsedSeconds || 0;
  const sincePush = generatedAt ? Math.max(0, (nowMs - generatedAt) / 1000) : 0;
  return initial + sincePush;
}

export function progressFromState(predictionState, generatedAt, nowMs = Date.now()) {
  if (!predictionState || predictionState.startProgressKm == null) {
    return null;
  }
  if (predictionState.modelMode === "hold") {
    return normalizeProgressKm(
      predictionState.startProgressKm,
      predictionState.routeLengthKm,
      predictionState.loop
    );
  }
  if (predictionState.modelType !== "route_constant_velocity") {
    return predictionState.startProgressKm;
  }
  const elapsed = elapsedSeconds(predictionState, generatedAt, nowMs);
  return normalizeProgressKm(
    predictionState.startProgressKm +
      (predictionState.speedMetersPerSecond * elapsed) / 1000,
    predictionState.routeLengthKm,
    predictionState.loop
  );
}

function haversineKm(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function pointAlongCoordinates(coordinates, progressKm) {
  if (!coordinates || coordinates.length < 2 || progressKm == null) {
    return null;
  }
  let remaining = Math.max(0, progressKm);
  for (let i = 0; i < coordinates.length - 1; i++) {
    const start = coordinates[i];
    const end = coordinates[i + 1];
    const segmentKm = haversineKm(start, end);
    if (segmentKm < 1e-6) {
      continue;
    }
    if (remaining <= segmentKm) {
      const t = remaining / segmentKm;
      return {
        longitude: start[0] + (end[0] - start[0]) * t,
        latitude: start[1] + (end[1] - start[1]) * t
      };
    }
    remaining -= segmentKm;
  }
  const last = coordinates[coordinates.length - 1];
  return { longitude: last[0], latitude: last[1] };
}

export function rangeCoordinates(coordinates, progressKm, p80Meters, routeLengthKm, loop) {
  if (progressKm == null || !p80Meters || !coordinates) {
    return null;
  }
  const deltaKm = p80Meters / 1000;
  const samples = [];
  const step = 0.008;
  for (let p = progressKm - deltaKm; p <= progressKm + deltaKm + 1e-9; p += step) {
    const normalized = normalizeProgressKm(p, routeLengthKm, loop);
    const point = pointAlongCoordinates(coordinates, normalized);
    if (point) {
      samples.push([point.latitude, point.longitude]);
    }
  }
  return samples.length >= 2 ? samples : null;
}

export function visualPredictedPosition(bus, routeCoordinates, nowMs = Date.now()) {
  const ps = bus.predictionState;
  if (!ps) {
    return bus.predicted
      ? { latitude: bus.predicted.latitude, longitude: bus.predicted.longitude }
      : null;
  }
  if (ps.modelType !== "route_constant_velocity") {
    return bus.predicted
      ? { latitude: bus.predicted.latitude, longitude: bus.predicted.longitude }
      : null;
  }
  if (ps.modelMode === "hold") {
    return {
      latitude: bus.reported.latitude,
      longitude: bus.reported.longitude
    };
  }
  const progressKm = progressFromState(ps, bus.generatedAt, nowMs);
  const along = pointAlongCoordinates(routeCoordinates, progressKm);
  if (along) {
    return along;
  }
  return bus.predicted
    ? { latitude: bus.predicted.latitude, longitude: bus.predicted.longitude }
    : null;
}
