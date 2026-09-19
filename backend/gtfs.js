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

// =====================================================
// 1. trip_id -> shape_id
// =====================================================
const tripToShape = new Map();
const tripToRouteId = new Map();
const MODEL7_ELIGIBLE_GTFS_ROUTE_ID = "CAS";

for (const trip of trips) {
    tripToShape.set(trip.trip_id, trip.shape_id);
    tripToRouteId.set(trip.trip_id, trip.route_id);
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

// =====================================================
// 6. Basic route progress
// =====================================================
function getRouteProgress(
    gtfsTripId,
    latitude,
    longitude
) {
    const shapeId =
        tripToShape.get(gtfsTripId);

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
    direction
) {
    const shapeId =
        tripToShape.get(gtfsTripId);

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
    progressKm
) {
    const shapeId =
        tripToShape.get(gtfsTripId);

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

    const shapeId =
        tripToShape.get(gtfsTripId);

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

    const shapeId =
        tripToShape.get(gtfsTripId);

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

    const shapeId =
        tripToShape.get(gtfsTripId);

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
    lookaheadMeters
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

    const shapeId =
        tripToShape.get(gtfsTripId);

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

function getRouteGeometry(gtfsTripId) {
    const shapeId =
        tripToShape.get(gtfsTripId);

    if (!shapeId) return null;

    const routeLine =
        shapeToLine.get(shapeId);

    if (!routeLine) return null;

    return routeLine.geometry.coordinates;
}

function isLoopTrip(gtfsTripId) {
    const shapeId =
        tripToShape.get(gtfsTripId);

    if (!shapeId) return false;

    return shapeIsLoop.get(shapeId) === true;
}

function getRouteLengthKm(gtfsTripId) {
    const shapeId =
        tripToShape.get(gtfsTripId);

    if (!shapeId) return null;

    return shapeRouteLengthsKm.get(shapeId) || null;
}

function getGtfsRouteId(gtfsTripId) {
    if (!gtfsTripId) {
        return null;
    }
    return tripToRouteId.get(gtfsTripId) || null;
}

function isModel7EligibleTrip(gtfsTripId) {
    return getGtfsRouteId(gtfsTripId) === MODEL7_ELIGIBLE_GTFS_ROUTE_ID;
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
    isModel7EligibleTrip,
    MODEL7_ELIGIBLE_GTFS_ROUTE_ID
};