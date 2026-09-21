const fs = require("fs");
const { parse } = require("csv-parse/sync");
const turf = require("@turf/turf");

// =====================================================
// 0. Read GTFS files
// =====================================================
const tripsText = fs.readFileSync("./trips.txt", "utf8");
const shapesText = fs.readFileSync("./shapes.txt", "utf8");
const stopsText = fs.readFileSync("./gtfs/stops.txt", "utf8");
const stopTimesText = fs.readFileSync("./gtfs/stop_times.txt", "utf8");
const routesPath = "./gtfs/routes.txt";
const routesText = fs.existsSync(routesPath)
    ? fs.readFileSync(routesPath, "utf8")
    : null;

const trips = parse(tripsText, {
    columns: true,
    skip_empty_lines: true
});

const shapes = parse(shapesText, {
    columns: true,
    skip_empty_lines: true
});

const stopsRows = parse(stopsText, {
    columns: true,
    skip_empty_lines: true
});

const stopTimesRows = parse(stopTimesText, {
    columns: true,
    skip_empty_lines: true
});

const routesRows = routesText
    ? parse(routesText, {
        columns: true,
        skip_empty_lines: true,
        bom: true
    })
    : [];

if (!routesText) {
    console.warn(
        "GTFS routes.txt not found at ./gtfs/routes.txt; using default marker colors"
    );
}

// =====================================================
// 1. trip_id -> shape_id
// =====================================================
const tripToShape = new Map();
const tripToRouteId = new Map();
const tripShapeAlias = new Map();
const shapesByRouteId = new Map();
const shapeCountByRoute = new Map();
const primaryShapeByRoute = new Map();
const MODEL7_ELIGIBLE_GTFS_ROUTE_ID = "CAS";

for (const trip of trips) {
    const shapeId = trip.shape_id && String(trip.shape_id).trim();
    if (shapeId) {
        tripToShape.set(trip.trip_id, shapeId);
    }
    tripToRouteId.set(trip.trip_id, trip.route_id);
    if (shapeId && trip.route_id) {
        if (!shapesByRouteId.has(trip.route_id)) {
            shapesByRouteId.set(trip.route_id, new Set());
            shapeCountByRoute.set(trip.route_id, new Map());
        }
        shapesByRouteId.get(trip.route_id).add(shapeId);
        const counts = shapeCountByRoute.get(trip.route_id);
        counts.set(shapeId, (counts.get(shapeId) || 0) + 1);
    }
}

for (const [routeId, counts] of shapeCountByRoute) {
    let bestShape = null;
    let bestCount = -1;
    for (const [shapeId, count] of counts) {
        if (count > bestCount) {
            bestShape = shapeId;
            bestCount = count;
        }
    }
    if (bestShape) {
        primaryShapeByRoute.set(routeId, bestShape);
    }
}

function normalizeGtfsHex(value) {
    if (!value || typeof value !== "string") {
        return null;
    }
    const hex = value.trim().replace(/^#/, "");
    if (!/^[0-9A-Fa-f]{6}$/.test(hex)) {
        return null;
    }
    return `#${hex.toUpperCase()}`;
}

const routeStylesById = new Map();

for (const row of routesRows) {
    if (!row.route_id) {
        continue;
    }
    routeStylesById.set(row.route_id, {
        color: normalizeGtfsHex(row.route_color),
        textColor: normalizeGtfsHex(row.route_text_color)
    });
}

// =====================================================
// 2. stop_id -> stop metadata
// =====================================================
const stopsById = new Map();

for (const row of stopsRows) {
    stopsById.set(row.stop_id, {
        stopId: row.stop_id,
        stopName: row.stop_name,
        latitude: Number(row.stop_lat),
        longitude: Number(row.stop_lon)
    });
}

// =====================================================
// 3. trip_id -> ordered stop_times
// =====================================================
const stopTimesByTrip = new Map();

for (const row of stopTimesRows) {
    if (!stopTimesByTrip.has(row.trip_id)) {
        stopTimesByTrip.set(row.trip_id, []);
    }

    const shapeDistance = Number(row.shape_dist_traveled);

    stopTimesByTrip.get(row.trip_id).push({
        stopId: row.stop_id,
        stopSequence: Number(row.stop_sequence),
        shapeDistance:
            Number.isFinite(shapeDistance)
                ? shapeDistance
                : null,
        arrivalTime: row.arrival_time,
        departureTime: row.departure_time,
        timepoint: Number(row.timepoint)
    });
}

for (const stops of stopTimesByTrip.values()) {
    stops.sort(
        (a, b) =>
            a.stopSequence - b.stopSequence
    );
}

// =====================================================
// 4. Group shapes by shape_id
//    Also remember the GTFS shape_dist_traveled length.
// =====================================================
const shapeGroups = new Map();
const shapeGtfsLengths = new Map();

for (const point of shapes) {
    const shapeId = point.shape_id;

    if (!shapeGroups.has(shapeId)) {
        shapeGroups.set(shapeId, []);
    }

    shapeGroups.get(shapeId).push(point);

    const shapeDistance = Number(
        point.shape_dist_traveled
    );

    if (Number.isFinite(shapeDistance)) {
        const oldLength =
            shapeGtfsLengths.get(shapeId) ?? 0;

        if (shapeDistance > oldLength) {
            shapeGtfsLengths.set(
                shapeId,
                shapeDistance
            );
        }
    }
}

// =====================================================
// 5. Convert each shape to Turf LineString
//    Cache route length and whether geometry is a loop.
// =====================================================
const shapeToLine = new Map();
const shapeRouteLengthsKm = new Map();
const shapeIsLoop = new Map();

for (const [shapeId, points] of shapeGroups) {
    points.sort(
        (a, b) =>
            Number(a.shape_pt_sequence) -
            Number(b.shape_pt_sequence)
    );

    const coordinates = points.map(point => [
        Number(point.shape_pt_lon),
        Number(point.shape_pt_lat)
    ]);

    if (coordinates.length < 2) {
        continue;
    }

    const line = turf.lineString(coordinates);

    const routeLengthKm = turf.length(
        line,
        { units: "kilometers" }
    );

    shapeToLine.set(shapeId, line);

    shapeRouteLengthsKm.set(
        shapeId,
        routeLengthKm
    );

    const firstPoint = turf.point(
        coordinates[0]
    );

    const lastPoint = turf.point(
        coordinates[coordinates.length - 1]
    );

    const endToStartMeters =
        turf.distance(
            firstPoint,
            lastPoint,
            { units: "kilometers" }
        ) * 1000;

    // MVP heuristic:
    // endpoints within 150m -> treat as loop
    shapeIsLoop.set(
        shapeId,
        endToStartMeters <= 150
    );
}

function pickShapeForRoute(routeId, latitude, longitude) {
    const shapeIds = shapesByRouteId.get(routeId);
    if (!shapeIds || shapeIds.size === 0) {
        return null;
    }
    if (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude)
    ) {
        const busPoint = turf.point([longitude, latitude]);
        let best = null;
        for (const shapeId of shapeIds) {
            const line = shapeToLine.get(shapeId);
            if (!line) continue;
            const snapped = turf.nearestPointOnLine(line, busPoint);
            const dist = snapped.properties.pointDistance;
            if (!best || dist < best.dist) {
                best = { shapeId, dist };
            }
        }
        if (best) {
            return best.shapeId;
        }
    }
    return primaryShapeByRoute.get(routeId) || [...shapeIds][0];
}

function resolveShapeId(
    gtfsTripId,
    routeId,
    latitude,
    longitude
) {
    if (gtfsTripId) {
        const mapped = tripToShape.get(gtfsTripId);
        if (mapped) {
            return mapped;
        }
        const aliased = tripShapeAlias.get(gtfsTripId);
        if (aliased) {
            return aliased;
        }
    }

    const rid = routeId || (gtfsTripId && tripToRouteId.get(gtfsTripId)) || null;
    if (!rid) {
        return null;
    }

    const shapeId = pickShapeForRoute(rid, latitude, longitude);
    if (shapeId && gtfsTripId) {
        tripShapeAlias.set(gtfsTripId, shapeId);
    }
    return shapeId;
}

// =====================================================
// 6. Basic route progress
// =====================================================
function getRouteProgress(
    gtfsTripId,
    latitude,
    longitude,
    routeId
) {
    const shapeId = resolveShapeId(
        gtfsTripId,
        routeId,
        latitude,
        longitude
    );

    if (!shapeId) {
        return null;
    }

    const routeLine =
        shapeToLine.get(shapeId);

    if (!routeLine) {
        return null;
    }

    const busPoint = turf.point([
        longitude,
        latitude
    ]);

    const snapped =
        turf.nearestPointOnLine(
            routeLine,
            busPoint
        );

    return {
        progressKm:
            snapped.properties.location,

        distanceFromRouteKm:
            snapped.properties.pointDistance,

        routeLengthKm:
            shapeRouteLengthsKm.get(shapeId)
    };
}

// =====================================================
// 7. Bearing helpers
// =====================================================
function normalizeBearing(angle) {
    return (angle + 360) % 360;
}

function bearingDifference(a, b) {
    const diff = Math.abs(
        normalizeBearing(a) -
        normalizeBearing(b)
    );

    return Math.min(diff, 360 - diff);
}

// =====================================================
// 8. Direction-aware route progress
// =====================================================
function getDirectedRouteProgress(
    gtfsTripId,
    latitude,
    longitude,
    direction,
    routeId
) {
    const shapeId = resolveShapeId(
        gtfsTripId,
        routeId,
        latitude,
        longitude
    );

    if (!shapeId) return null;

    const routeLine =
        shapeToLine.get(shapeId);

    if (!routeLine) return null;

    const coordinates =
        routeLine.geometry.coordinates;

    const busPoint = turf.point([
        longitude,
        latitude
    ]);

    const candidates = [];

    let progressBeforeSegment = 0;

    for (
        let i = 0;
        i < coordinates.length - 1;
        i++
    ) {
        const start = coordinates[i];
        const end = coordinates[i + 1];

        const segment = turf.lineString([
            start,
            end
        ]);

        const snapped =
            turf.nearestPointOnLine(
                segment,
                busPoint
            );

        const distanceMeters =
            snapped.properties.pointDistance *
            1000;

        const segmentBearing =
            normalizeBearing(
                turf.bearing(
                    turf.point(start),
                    turf.point(end)
                )
            );

        const directionDifference =
            bearingDifference(
                segmentBearing,
                direction
            );

        const progressKm =
            progressBeforeSegment +
            snapped.properties.location;

        candidates.push({
            segmentIndex: i,
            distanceMeters,
            segmentBearing,
            directionDifference,
            progressKm,
            latitude:
                snapped.geometry.coordinates[1],
            longitude:
                snapped.geometry.coordinates[0]
        });

        progressBeforeSegment +=
            turf.distance(
                turf.point(start),
                turf.point(end),
                { units: "kilometers" }
            );
    }

    // Existing MVP rule:
    // only consider route segments within 50m
    const nearbyCandidates =
        candidates.filter(
            candidate =>
                candidate.distanceMeters <= 50
        );

    if (nearbyCandidates.length === 0) {
        return null;
    }

    nearbyCandidates.sort(
        (a, b) =>
            a.directionDifference -
            b.directionDifference
    );

    const bestCandidate =
        nearbyCandidates[0];

    return {
        ...bestCandidate,
        routeLengthKm: progressBeforeSegment
    };
}

// =====================================================
// 9. Get point on route by Turf progress (km)
// =====================================================
function getRoutePoint(
    gtfsTripId,
    progressKm,
    routeId
) {
    const shapeId = resolveShapeId(gtfsTripId, routeId);

    if (!shapeId) return null;

    const routeLine =
        shapeToLine.get(shapeId);

    if (!routeLine) return null;

    const routeLengthKm =
        shapeRouteLengthsKm.get(shapeId);

    if (
        !routeLengthKm ||
        routeLengthKm <= 0
    ) {
        return null;
    }

    let normalizedProgressKm =
        progressKm;

    if (shapeIsLoop.get(shapeId)) {
        normalizedProgressKm =
            (
                (
                    progressKm %
                    routeLengthKm
                ) +
                routeLengthKm
            ) %
            routeLengthKm;
    } else {
        normalizedProgressKm =
            Math.max(
                0,
                Math.min(
                    progressKm,
                    routeLengthKm
                )
            );
    }

    const point = turf.along(
        routeLine,
        normalizedProgressKm,
        { units: "kilometers" }
    );

    const [longitude, latitude] =
        point.geometry.coordinates;

    return {
        latitude,
        longitude,
        progressKm: normalizedProgressKm
    };
}

// =====================================================
// 10. GTFS shape distance -> Turf progress
//
// Important:
// We do NOT assume shape_dist_traveled is meters.
// We use its ratio along the complete GTFS shape.
// =====================================================
function gtfsShapeDistanceToProgressKm(
    shapeId,
    shapeDistance
) {
    if (
        shapeDistance === null ||
        shapeDistance === undefined
    ) {
        return null;
    }

    const gtfsShapeLength =
        shapeGtfsLengths.get(shapeId);

    const routeLengthKm =
        shapeRouteLengthsKm.get(shapeId);

    if (
        !gtfsShapeLength ||
        gtfsShapeLength <= 0 ||
        !routeLengthKm ||
        routeLengthKm <= 0
    ) {
        return null;
    }

    return (
        shapeDistance /
        gtfsShapeLength
    ) * routeLengthKm;
}

// =====================================================
// 11. Find next scheduled stop
// =====================================================
function getNextStopInfo(
    gtfsTripId,
    currentProgressKm
) {
    const tripStops =
        stopTimesByTrip.get(gtfsTripId);

    if (
        !tripStops ||
        tripStops.length === 0
    ) {
        return null;
    }

    const shapeId = resolveShapeId(gtfsTripId);

    if (!shapeId) {
        return null;
    }

    const routeLengthKm =
        shapeRouteLengthsKm.get(shapeId);

    if (
        !routeLengthKm ||
        routeLengthKm <= 0
    ) {
        return null;
    }

    const stopCandidates = [];

    for (const stopTime of tripStops) {
        const stopProgressKm =
            gtfsShapeDistanceToProgressKm(
                shapeId,
                stopTime.shapeDistance
            );

        if (stopProgressKm === null) {
            continue;
        }

        const stop =
            stopsById.get(
                stopTime.stopId
            );

        stopCandidates.push({
            stopId:
                stopTime.stopId,

            stopName:
                stop?.stopName ?? null,

            stopLatitude:
                stop?.latitude ?? null,

            stopLongitude:
                stop?.longitude ?? null,

            stopSequence:
                stopTime.stopSequence,

            stopProgressKm,

            arrivalTime:
                stopTime.arrivalTime,

            departureTime:
                stopTime.departureTime,

            timepoint:
                stopTime.timepoint
        });
    }

    if (stopCandidates.length === 0) {
        return null;
    }

    stopCandidates.sort(
        (a, b) =>
            a.stopProgressKm -
            b.stopProgressKm
    );

    // 5 meters:
    // avoid repeatedly returning the stop
    // the bus is effectively already sitting on.
    const PASS_TOLERANCE_KM = 0.005;

    const nextStop =
        stopCandidates.find(
            stop =>
                stop.stopProgressKm >
                currentProgressKm +
                PASS_TOLERANCE_KM
        );

    if (nextStop) {
        return {
            ...nextStop,

            distanceMeters:
                (
                    nextStop.stopProgressKm -
                    currentProgressKm
                ) * 1000,

            wrapped: false
        };
    }

    // End of non-loop trip
    if (!shapeIsLoop.get(shapeId)) {
        return null;
    }

    // Loop route:
    // after final stop, next stop is at
    // beginning of shape.
    const firstStop =
        stopCandidates[0];

    return {
        ...firstStop,

        distanceMeters:
            (
                routeLengthKm -
                currentProgressKm +
                firstStop.stopProgressKm
            ) * 1000,

        wrapped: true
    };
}

function getPreviousStopInfo(
    gtfsTripId,
    currentProgressKm
) {
    const tripStops =
        stopTimesByTrip.get(gtfsTripId);

    if (
        !tripStops ||
        tripStops.length === 0
    ) {
        return null;
    }

    const shapeId = resolveShapeId(gtfsTripId);

    if (!shapeId) {
        return null;
    }

    const routeLengthKm =
        shapeRouteLengthsKm.get(shapeId);

    if (
        !routeLengthKm ||
        routeLengthKm <= 0
    ) {
        return null;
    }

    const stopCandidates = [];

    for (const stopTime of tripStops) {
        const stopProgressKm =
            gtfsShapeDistanceToProgressKm(
                shapeId,
                stopTime.shapeDistance
            );

        if (stopProgressKm === null) {
            continue;
        }

        const stop =
            stopsById.get(
                stopTime.stopId
            );

        stopCandidates.push({
            stopId:
                stopTime.stopId,

            stopName:
                stop?.stopName ?? null,

            stopLatitude:
                stop?.latitude ?? null,

            stopLongitude:
                stop?.longitude ?? null,

            stopSequence:
                stopTime.stopSequence,

            stopProgressKm,

            arrivalTime:
                stopTime.arrivalTime,

            departureTime:
                stopTime.departureTime,

            timepoint:
                stopTime.timepoint
        });
    }

    if (stopCandidates.length === 0) {
        return null;
    }

    stopCandidates.sort(
        (a, b) =>
            a.stopProgressKm -
            b.stopProgressKm
    );

    const PASS_TOLERANCE_KM = 0.005;

    let previousStop = null;
    for (const stop of stopCandidates) {
        if (
            stop.stopProgressKm <
            currentProgressKm - PASS_TOLERANCE_KM
        ) {
            previousStop = stop;
        }
    }

    if (previousStop) {
        return {
            ...previousStop,
            distanceMeters:
                (
                    currentProgressKm -
                    previousStop.stopProgressKm
                ) * 1000,
            wrapped: false
        };
    }

    const lastStop =
        stopCandidates[stopCandidates.length - 1];

    return {
        ...lastStop,
        distanceMeters:
            (
                currentProgressKm +
                routeLengthKm -
                lastStop.stopProgressKm
            ) * 1000,
        wrapped: true
    };
}

// =====================================================
// 12. Return all stops for a trip
//
// Useful for:
// debugging
// stop-aware predictor
// frontend route visualization
// =====================================================
function getTripStops(
    gtfsTripId
) {
    const tripStops =
        stopTimesByTrip.get(gtfsTripId);

    if (!tripStops) {
        return [];
    }

    const shapeId = resolveShapeId(gtfsTripId);

    if (!shapeId) {
        return [];
    }

    return tripStops
        .map(stopTime => {
            const stopProgressKm =
                gtfsShapeDistanceToProgressKm(
                    shapeId,
                    stopTime.shapeDistance
                );

            if (
                stopProgressKm === null
            ) {
                return null;
            }

            const stop =
                stopsById.get(
                    stopTime.stopId
                );

            return {
                stopId:
                    stopTime.stopId,

                stopName:
                    stop?.stopName ?? null,

                stopSequence:
                    stopTime.stopSequence,

                stopProgressKm,

                arrivalTime:
                    stopTime.arrivalTime,

                departureTime:
                    stopTime.departureTime,

                timepoint:
                    stopTime.timepoint
            };
        })
        .filter(Boolean);
}

// =====================================================
// 13. Upcoming turn diagnostic (does NOT change speed)
// =====================================================
function getUpcomingTurnInfo(
    gtfsTripId,
    currentProgressKm,
    lookaheadMeters,
    routeId
) {
    if (
        currentProgressKm === null ||
        currentProgressKm === undefined
    ) {
        return null;
    }

    const lookahead =
        Number.isFinite(lookaheadMeters)
            ? lookaheadMeters
            : 250;

    const shapeId = resolveShapeId(gtfsTripId, routeId);

    if (!shapeId) return null;

    const routeLine =
        shapeToLine.get(shapeId);

    if (!routeLine) return null;

    const coordinates =
        routeLine.geometry.coordinates;

    const lookaheadKm = lookahead / 1000;
    const TURN_THRESHOLD_DEGREES = 45;
    const maxProgressKm =
        currentProgressKm + lookaheadKm;

    let progressKm = 0;
    let previousBearing = null;

    for (
        let i = 0;
        i < coordinates.length - 1;
        i++
    ) {
        const start = coordinates[i];
        const end = coordinates[i + 1];

        const startPoint = turf.point(start);
        const endPoint = turf.point(end);

        const segmentLengthKm = turf.distance(
            startPoint,
            endPoint,
            { units: "kilometers" }
        );

        if (segmentLengthKm < 0.003) {
            progressKm += segmentLengthKm;
            continue;
        }

        const segmentBearing =
            normalizeBearing(
                turf.bearing(startPoint, endPoint)
            );

        const vertexProgressKm = progressKm;

        if (
            previousBearing !== null &&
            vertexProgressKm > currentProgressKm &&
            vertexProgressKm <= maxProgressKm
        ) {
            const turnAngleDegrees =
                bearingDifference(
                    previousBearing,
                    segmentBearing
                );

            if (turnAngleDegrees >= TURN_THRESHOLD_DEGREES) {
                const incoming = [
                    end[0] - start[0],
                    end[1] - start[1]
                ];
                const prev = coordinates[i - 1];
                const outgoingFromPrev = [
                    start[0] - prev[0],
                    start[1] - prev[1]
                ];
                const cross =
                    outgoingFromPrev[0] * incoming[1] -
                    outgoingFromPrev[1] * incoming[0];

                return {
                    distanceToTurnMeters:
                        (vertexProgressKm - currentProgressKm) *
                        1000,
                    turnAngleDegrees,
                    turnDirection:
                        cross > 0 ? "left" : "right",
                    turnProgressKm: vertexProgressKm
                };
            }
        }

        previousBearing = segmentBearing;
        progressKm += segmentLengthKm;
    }

    return null;
}

function getRouteGeometry(gtfsTripId, routeId, latitude, longitude) {
    const shapeId = resolveShapeId(
        gtfsTripId,
        routeId,
        latitude,
        longitude
    );

    if (!shapeId) return null;

    const routeLine =
        shapeToLine.get(shapeId);

    if (!routeLine) return null;

    return routeLine.geometry.coordinates;
}

function isLoopTrip(gtfsTripId, routeId) {
    const shapeId = resolveShapeId(gtfsTripId, routeId);

    if (!shapeId) return false;

    return shapeIsLoop.get(shapeId) === true;
}

function getRouteLengthKm(gtfsTripId, routeId, latitude, longitude) {
    const shapeId = resolveShapeId(
        gtfsTripId,
        routeId,
        latitude,
        longitude
    );

    if (!shapeId) return null;

    return shapeRouteLengthsKm.get(shapeId) || null;
}

function getGtfsRouteId(gtfsTripId, routeId) {
    if (gtfsTripId && tripToRouteId.has(gtfsTripId)) {
        return tripToRouteId.get(gtfsTripId);
    }
    return routeId || null;
}

function isModel7EligibleTrip(gtfsTripId, routeId) {
    return getGtfsRouteId(gtfsTripId, routeId) === MODEL7_ELIGIBLE_GTFS_ROUTE_ID;
}

function getRouteStyle(gtfsTripId, fallbackRouteId) {
    const gtfsRouteId = getGtfsRouteId(gtfsTripId);
    const style =
        (gtfsRouteId && routeStylesById.get(gtfsRouteId)) ||
        (fallbackRouteId && routeStylesById.get(fallbackRouteId)) ||
        null;
    return {
        gtfsRouteId: gtfsRouteId || null,
        routeColor: style?.color || null,
        routeTextColor: style?.textColor || null
    };
}

module.exports = {
    getRouteProgress,
    getRoutePoint,
    getDirectedRouteProgress,

    getNextStopInfo,
    getPreviousStopInfo,
    getTripStops,
    getUpcomingTurnInfo,
    getRouteGeometry,
    isLoopTrip,
    getRouteLengthKm,
    getGtfsRouteId,
    getRouteStyle,
    isModel7EligibleTrip,
    MODEL7_ELIGIBLE_GTFS_ROUTE_ID
};