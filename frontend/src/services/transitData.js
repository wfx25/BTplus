export const FRESH_THRESHOLD_SECONDS = 15;
export const STALE_THRESHOLD_SECONDS = 30;

const mockRoutes = {
  "mock-ucb": [
    [-80.4256, 37.2248],
    [-80.4238, 37.2262],
    [-80.4219, 37.2281],
    [-80.4202, 37.2304],
    [-80.4188, 37.2324],
    [-80.4174, 37.2340]
  ]
};

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizePosition(position) {
  if (!position) return null;
  const latitude = finiteNumber(position.latitude);
  const longitude = finiteNumber(position.longitude);
  return latitude == null || longitude == null
    ? null
    : { ...position, latitude, longitude };
}

export function normalizeTransitMessage(raw) {
  const message = raw && typeof raw === "object" ? raw : {};
  const buses = Array.isArray(message.buses) ? message.buses : [];

  return {
    ...message,
    timestamp: finiteNumber(message.timestamp, Date.now()),
    generatedAt: finiteNumber(message.generatedAt, message.timestamp || Date.now()),
    sourceMode: message.sourceMode || message.mode || "live",
    buses: buses
      .map((bus) => {
        const reported = normalizePosition(bus.reported || bus);
        if (!reported || bus.id == null) return null;

        const prediction = normalizePosition(bus.predicted);
        return {
          ...bus,
          id: String(bus.id),
          routeId: bus.routeId || "Unknown",
          patternName: bus.patternName || null,
          reported: {
            ...reported,
            version: finiteNumber(reported.version, finiteNumber(bus.version, Date.now())),
            speed: finiteNumber(reported.speed, finiteNumber(bus.speed, 0)),
            direction: finiteNumber(reported.direction, finiteNumber(bus.direction))
          },
          predicted: prediction,
          generatedAt: finiteNumber(bus.generatedAt, message.generatedAt || Date.now())
        };
      })
      .filter(Boolean)
  };
}

export function getDisplayedDataAgeSeconds(bus, nowMs = Date.now()) {
  const initial = finiteNumber(
    bus?.predictionState?.initialElapsedSeconds,
    finiteNumber(bus?.reported?.dataAge, finiteNumber(bus?.dataAge, 0))
  );
  const generatedAt = finiteNumber(bus?.generatedAt, nowMs);
  return Math.max(0, initial + Math.max(0, (nowMs - generatedAt) / 1000));
}

export function freshnessForAge(ageSeconds) {
  if (ageSeconds < FRESH_THRESHOLD_SECONDS) return "fresh";
  if (ageSeconds < STALE_THRESHOLD_SECONDS) return "recent";
  return "stale";
}

export function distanceMetersBetween(first, second) {
  if (!first || !second) return null;
  const toRadians = Math.PI / 180;
  const dLatitude = (second.latitude - first.latitude) * toRadians;
  const dLongitude = (second.longitude - first.longitude) * toRadians;
  const a =
    Math.sin(dLatitude / 2) ** 2 +
    Math.cos(first.latitude * toRadians) *
      Math.cos(second.latitude * toRadians) *
      Math.sin(dLongitude / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function getMockRouteCoordinates(tripId) {
  return mockRoutes[tripId] || null;
}

export function createMockState(nowMs = Date.now()) {
  const reportedVersion = nowMs - 22_000;
  return normalizeTransitMessage({
    timestamp: nowMs,
    generatedAt: nowMs,
    sourceMode: "mock",
    buses: [
      {
        id: "6402",
        routeId: "UCB",
        patternName: "Mock University City Boulevard",
        gtfsTripId: "mock-ucb",
        reported: {
          latitude: 37.2281,
          longitude: -80.4219,
          version: reportedVersion,
          speed: 7.2,
          direction: 42,
          dataAge: 22
        },
        predicted: {
          latitude: 37.2294,
          longitude: -80.4210,
          predictionHorizonSeconds: 22,
          modelMode: "moving",
          progressKm: 0.55
        },
        predictionState: {
          modelType: "route_constant_velocity",
          modelMode: "moving",
          startProgressKm: 0.37,
          initialElapsedSeconds: 22,
          speedMetersPerSecond: 7.2,
          routeLengthKm: 1.45,
          loop: false
        },
        uncertainty: { p80Meters: 85, label: "Mock P80 route-aligned range" }
      }
    ],
    evaluation: {
      samples: 18,
      avgBaselineMeters: 86,
      avgConstantMeters: 31,
      avgMotionMeters: 23,
      motion: { wins: 14, ties: 2, losses: 2 }
    },
    uncertaintyCalibration: []
  });
}
