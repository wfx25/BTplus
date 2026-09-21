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

function backendPredicted(bus) {
  const latitude = bus.predicted?.latitude;
  const longitude = bus.predicted?.longitude;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return { latitude, longitude };
}

export function usableRouteCoordinates(routeCoordinates) {
  return Array.isArray(routeCoordinates) && routeCoordinates.length >= 2
    ? routeCoordinates
    : null;
}

function isHold(bus) {
  const mode = bus.predictionState?.modelMode || bus.predicted?.modelMode;
  if (mode === "hold") return true;
  const speed =
    bus.predictionState?.speedMetersPerSecond ??
    bus.reported?.speed ??
    bus.speed;
  return Number.isFinite(speed) && speed <= 1;
}

function positionsOverlap(a, b, meters = 12) {
  if (!a || !b) return false;
  if (
    !Number.isFinite(a.latitude) ||
    !Number.isFinite(a.longitude) ||
    !Number.isFinite(b.latitude) ||
    !Number.isFinite(b.longitude)
  ) {
    return false;
  }
  return haversineKm([a.longitude, a.latitude], [b.longitude, b.latitude]) * 1000 < meters;
}

export function nearestProgressKm(coordinates, longitude, latitude, maxDistanceMeters = 250) {
  const coords = usableRouteCoordinates(coordinates);
  if (!coords || !Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    return null;
  }

  const busPoint = [longitude, latitude];
  let best = null;
  let traveled = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const start = coords[i];
    const end = coords[i + 1];
    const segmentKm = haversineKm(start, end);
    if (segmentKm < 1e-6) {
      continue;
    }
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const spanSq = dx * dx + dy * dy;
    let t = ((busPoint[0] - start[0]) * dx + (busPoint[1] - start[1]) * dy) / spanSq;
    t = Math.max(0, Math.min(1, t));
    const projected = [start[0] + dx * t, start[1] + dy * t];
    const distanceMeters = haversineKm(busPoint, projected) * 1000;
    if (best == null || distanceMeters < best.distanceMeters) {
      best = {
        progressKm: traveled + t * segmentKm,
        distanceMeters
      };
    }
    traveled += segmentKm;
  }

  if (!best || best.distanceMeters > maxDistanceMeters) {
    return null;
  }
  return best.progressKm;
}

export function destinationPoint(latitude, longitude, bearingDeg, distanceMeters) {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(bearingDeg) ||
    !Number.isFinite(distanceMeters)
  ) {
    return null;
  }
  const radius = 6371000;
  const angularDistance = distanceMeters / radius;
  const bearing = (bearingDeg * Math.PI) / 180;
  const lat1 = (latitude * Math.PI) / 180;
  const lon1 = (longitude * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );
  return {
    latitude: (lat2 * 180) / Math.PI,
    longitude: ((lon2 * 180) / Math.PI + 540) % 360 - 180
  };
}

export function deadReckonedPosition(bus, nowMs = Date.now()) {
  const reported = bus.reported;
  if (!reported) return null;
  const speed =
    bus.predictionState?.speedMetersPerSecond ?? reported.speed ?? bus.speed;
  const heading = reported.direction ?? bus.direction;
  if (!Number.isFinite(speed) || speed <= 1 || !Number.isFinite(heading)) {
    return null;
  }
  const elapsed = bus.predictionState
    ? elapsedSeconds(bus.predictionState, bus.generatedAt, nowMs)
    : Math.max(0, reported.dataAge ?? bus.dataAge ?? 0);
  if (!Number.isFinite(elapsed) || elapsed <= 0) {
    return null;
  }
  return destinationPoint(reported.latitude, reported.longitude, heading, speed * elapsed);
}

function alongRoutePosition(bus, routeCoordinates, nowMs) {
  const coords = usableRouteCoordinates(routeCoordinates);
  if (!coords) return null;

  const ps = bus.predictionState;
  let progressKm = progressFromState(ps, bus.generatedAt, nowMs);
  if (progressKm == null && bus.reported) {
    const snapped = nearestProgressKm(
      coords,
      bus.reported.longitude,
      bus.reported.latitude
    );
    if (snapped != null) {
      const speed = ps?.speedMetersPerSecond ?? bus.reported.speed ?? bus.speed ?? 0;
      const elapsed = ps ? elapsedSeconds(ps, bus.generatedAt, nowMs) : 0;
      progressKm = normalizeProgressKm(
        snapped + (Number.isFinite(speed) ? (speed * elapsed) / 1000 : 0),
        ps?.routeLengthKm,
        ps?.loop
      );
    }
  }
  return pointAlongCoordinates(coords, progressKm);
}

function visiblePrediction(bus, position) {
  if (!position) return null;
  if (bus.reported && positionsOverlap(position, bus.reported)) {
    return null;
  }
  return position;
}

export function visualPredictedPosition(bus, routeCoordinates, nowMs = Date.now()) {
  if (isHold(bus)) {
    return null;
  }

  return (
    visiblePrediction(bus, alongRoutePosition(bus, routeCoordinates, nowMs)) ||
    visiblePrediction(bus, backendPredicted(bus)) ||
    visiblePrediction(bus, deadReckonedPosition(bus, nowMs))
  );
}
