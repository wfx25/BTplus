"use strict";

const featureSpec = require("./model7safe-feature-spec.json");
const {
    getDirectedRouteProgress,
    getRouteLengthKm,
    getNextStopInfo,
    getPreviousStopInfo,
    isLoopTrip
} = require("../gtfs");

const FEATURE_ORDER = featureSpec.featureOrder;
const KNOWN_SNAP_FLIP_PAIRS = new Set(
    featureSpec.historyBreaks.knownSnapFlipPairs
);

function wrapPositive(deltaKm, routeLengthKm) {
    if (!(routeLengthKm > 0) || !Number.isFinite(deltaKm)) {
        return deltaKm;
    }
    let wrapped = deltaKm % routeLengthKm;
    if (wrapped < 0) {
        wrapped += routeLengthKm;
    }
    return wrapped;
}

function wrapToSigned(deltaKm, routeLengthKm) {
    if (!(routeLengthKm > 0) || !Number.isFinite(deltaKm)) {
        return deltaKm;
    }
    let wrapped = wrapPositive(deltaKm, routeLengthKm);
    if (wrapped > routeLengthKm / 2) {
        wrapped -= routeLengthKm;
    }
    return wrapped;
}

function snapFlipKey(prev, curr) {
    return `${curr.busId}|${curr.gtfsTripId}|${prev.version}|${curr.version}`;
}

function usableHistoryLink(prev, curr) {
    if (!prev || !curr) {
        return false;
    }
    if (prev.busId !== curr.busId) {
        return false;
    }
    if (prev.gtfsTripId !== curr.gtfsTripId) {
        return false;
    }
    if (
        !Number.isFinite(prev.progressKm) ||
        !Number.isFinite(curr.progressKm)
    ) {
        return false;
    }

    const dtSeconds = (curr.version - prev.version) / 1000;
    if (!(dtSeconds > 0)) {
        return false;
    }
    if (dtSeconds > 60) {
        return false;
    }
    if (KNOWN_SNAP_FLIP_PAIRS.has(snapFlipKey(prev, curr))) {
        return false;
    }

    const routeLengthKm = curr.routeLengthKm;
    if (!(routeLengthKm > 0)) {
        return false;
    }

    const rawDeltaKm = curr.progressKm - prev.progressKm;
    const terminusWrap =
        rawDeltaKm < -0.5 &&
        wrapPositive(rawDeltaKm, routeLengthKm) < 0.8;
    if (rawDeltaKm < -0.3 && !terminusWrap) {
        return false;
    }
    return true;
}

function buildEnrichedObservation(bus) {
    if (!bus || !bus.gtfsTripId || !bus.id) {
        return null;
    }
    if (!Number.isFinite(bus.speed) || !Number.isFinite(bus.version)) {
        return null;
    }

    const directed = getDirectedRouteProgress(
        bus.gtfsTripId,
        bus.latitude,
        bus.longitude,
        bus.direction
    );
    if (!directed || !Number.isFinite(directed.progressKm)) {
        return null;
    }

    const routeLengthKm = getRouteLengthKm(bus.gtfsTripId);
    if (!(routeLengthKm > 0)) {
        return null;
    }

    return {
        busId: bus.id,
        gtfsTripId: bus.gtfsTripId,
        version: bus.version,
        speed: bus.speed,
        latitude: bus.latitude,
        longitude: bus.longitude,
        direction: bus.direction,
        isBusAtStop: bus.isBusAtStop === true,
        progressKm: directed.progressKm,
        routeLengthKm,
        loop: isLoopTrip(bus.gtfsTripId)
    };
}

class ObservationHistory {
    constructor() {
        this.byBus = new Map();
        this.resetCount = 0;
        this.resetReasons = {};
    }

    resetAll() {
        this.byBus.clear();
    }

    reset(busId, reason) {
        if (this.byBus.has(busId)) {
            this.byBus.delete(busId);
            this.resetCount += 1;
            const key = reason || "unspecified";
            this.resetReasons[key] = (this.resetReasons[key] || 0) + 1;
        }
    }

    get(busId) {
        return this.byBus.get(busId) || [];
    }

    record(observation) {
        if (
            !observation ||
            !observation.busId ||
            !Number.isFinite(observation.progressKm) ||
            !(observation.routeLengthKm > 0) ||
            !observation.gtfsTripId
        ) {
            if (observation && observation.busId) {
                this.reset(observation.busId, "invalid_observation");
            }
            return { recorded: false, reason: "invalid_observation" };
        }

        let hist = this.byBus.get(observation.busId);
        if (!hist) {
            hist = [];
            this.byBus.set(observation.busId, hist);
        }

        const last = hist[hist.length - 1];
        if (last && last.gtfsTripId !== observation.gtfsTripId) {
            hist.length = 0;
            this.resetCount += 1;
            this.resetReasons.gtfsTripId_change =
                (this.resetReasons.gtfsTripId_change || 0) + 1;
        } else if (last && observation.version < last.version) {
            hist.length = 0;
            this.resetCount += 1;
            this.resetReasons.time_went_backward =
                (this.resetReasons.time_went_backward || 0) + 1;
        } else if (last && last.version === observation.version) {
            return { recorded: false, reason: "duplicate_version" };
        }

        hist.push(observation);
        if (hist.length > 8) {
            hist.splice(0, hist.length - 8);
        }
        return { recorded: true };
    }
}

function nan() {
    return Number.NaN;
}

function olsSpeedSlope(points) {
    if (!points || points.length < 2) {
        return nan();
    }
    const n = points.length;
    let meanT = 0;
    let meanV = 0;
    for (const point of points) {
        meanT += point.t;
        meanV += point.v;
    }
    meanT /= n;
    meanV /= n;

    let numerator = 0;
    let denominator = 0;
    for (const point of points) {
        const dt = point.t - meanT;
        numerator += dt * (point.v - meanV);
        denominator += dt * dt;
    }
    if (denominator <= 1e-9) {
        return nan();
    }
    return numerator / denominator;
}

function historyThrough(history, busId, version) {
    return history.get(busId).filter(obs => obs.version <= version);
}

function buildFeatureVector(current, previousUnique, horizonSeconds) {
    if (!current) {
        return {
            ok: false,
            reason: "missing_current_observation"
        };
    }
    if (!Number.isFinite(current.speed)) {
        return { ok: false, reason: "invalid_current_speed" };
    }
    if (!Number.isFinite(horizonSeconds)) {
        return { ok: false, reason: "invalid_horizon" };
    }
    if (
        !Number.isFinite(current.progressKm) ||
        !(current.routeLengthKm > 0)
    ) {
        return { ok: false, reason: "invalid_route_match" };
    }
    if (!current.gtfsTripId) {
        return { ok: false, reason: "invalid_trip" };
    }

    const twoPi = 2 * Math.PI;
    const progressFraction =
        current.progressKm / current.routeLengthKm;
    const progressSin = Math.sin(twoPi * progressFraction);
    const progressCos = Math.cos(twoPi * progressFraction);

    const prev1 = previousUnique[0] || null;
    const prev2 = previousUnique[1] || null;
    const prev3 = previousUnique[2] || null;

    const dtPrev1 = prev1
        ? (current.version - prev1.version) / 1000
        : nan();
    const link1 = usableHistoryLink(prev1, current);
    const prevSpeed1 = link1 ? prev1.speed : nan();

    const link2 = link1 && usableHistoryLink(prev2, prev1);
    const prevSpeed2 = link2 ? prev2.speed : nan();
    const dtPrev2 = link2
        ? (prev1.version - prev2.version) / 1000
        : nan();

    const link3 = link2 && usableHistoryLink(prev3, prev2);
    const prevSpeed3 = link3 ? prev3.speed : nan();
    const dtPrev3 = link3
        ? (prev2.version - prev3.version) / 1000
        : nan();

    const speedDelta1 = Number.isFinite(prevSpeed1)
        ? current.speed - prevSpeed1
        : nan();
    const speedDelta2 =
        Number.isFinite(prevSpeed1) && Number.isFinite(prevSpeed2)
            ? prevSpeed1 - prevSpeed2
            : nan();

    const slopePoints = [{ t: 0, v: current.speed }];
    let later = current;
    let elapsed = 0;
    const walk = [prev1, prev2, prev3];
    for (const prev of walk) {
        if (!usableHistoryLink(prev, later)) {
            break;
        }
        const dt = (later.version - prev.version) / 1000;
        elapsed -= dt;
        slopePoints.push({ t: elapsed, v: prev.speed });
        later = prev;
    }
    const recentSpeedSlope = olsSpeedSlope(slopePoints);

    let previousRealizedRouteSpeed = nan();
    if (
        Number.isFinite(prevSpeed1) &&
        Number.isFinite(dtPrev1) &&
        dtPrev1 > 0
    ) {
        const signedKm = wrapToSigned(
            current.progressKm - prev1.progressKm,
            current.routeLengthKm
        );
        previousRealizedRouteSpeed = (signedKm * 1000) / dtPrev1;
    }

    const nextStop = getNextStopInfo(
        current.gtfsTripId,
        current.progressKm
    );
    const previousStop = getPreviousStopInfo(
        current.gtfsTripId,
        current.progressKm
    );

    const values = [
        current.speed,
        horizonSeconds,
        current.isBusAtStop ? 1 : 0,
        progressSin,
        progressCos,
        prevSpeed1,
        prevSpeed2,
        prevSpeed3,
        dtPrev1,
        dtPrev2,
        dtPrev3,
        speedDelta1,
        speedDelta2,
        recentSpeedSlope,
        previousRealizedRouteSpeed,
        nextStop && Number.isFinite(nextStop.distanceMeters)
            ? nextStop.distanceMeters
            : nan(),
        previousStop && Number.isFinite(previousStop.distanceMeters)
            ? previousStop.distanceMeters
            : nan()
    ];

    if (!Number.isFinite(values[0]) || !Number.isFinite(values[1])) {
        return { ok: false, reason: "required_feature_nonfinite" };
    }
    if (!Number.isFinite(values[3]) || !Number.isFinite(values[4])) {
        return { ok: false, reason: "progress_trig_nonfinite" };
    }

    return {
        ok: true,
        values,
        names: FEATURE_ORDER
    };
}

function previousUniqueFromHistory(hist, current) {
    const older = [];
    for (let i = hist.length - 1; i >= 0; i -= 1) {
        const obs = hist[i];
        if (obs.version < current.version && obs.busId === current.busId) {
            older.push(obs);
        }
        if (older.length >= 3) {
            break;
        }
    }
    return older;
}

module.exports = {
    FEATURE_ORDER,
    KNOWN_SNAP_FLIP_PAIRS,
    wrapPositive,
    wrapToSigned,
    usableHistoryLink,
    buildEnrichedObservation,
    ObservationHistory,
    buildFeatureVector,
    previousUniqueFromHistory,
    historyThrough
};
