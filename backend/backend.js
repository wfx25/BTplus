const turf = require("@turf/turf");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

function cliValue(name, envName, fallback) {
    const flag = `--${name}`;
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === flag && argv[i + 1] && !argv[i + 1].startsWith("-")) {
            return argv[i + 1];
        }
        if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    }
    if (envName && process.env[envName] != null && process.env[envName] !== "") {
        return process.env[envName];
    }
    return fallback;
}

const BT_API_URL =
    "https://ridebt.org/index.php?option=com_ajax&module=bt_map&method=getBuses&format=json&Itemid=101&method=getBuses";
const BT_MODE = cliValue("mode", "BT_MODE", "live");
const PORT = Number(cliValue("port", "PORT", "3000"));
const {
    getRouteProgress,
    getRoutePoint,
    getDirectedRouteProgress,
    getNextStopInfo,
    getUpcomingTurnInfo,
    getRouteGeometry,
    isLoopTrip,
    getRouteLengthKm,
    getRouteStyle,
    isModel7EligibleTrip
} = require("./gtfs");
const {
    createModel7Runtime
} = require("./model7/predictor");
const { buildValidationPayload } = require("./model7/validationStats");
const busStore = new Map();
const evaluatedVersions = new Map();
const predictionHistory = [];
const PREDICTION_HISTORY_LIMIT = 2000;
const RECORDING_FILE =
    process.env.BT_RECORD_FILE || "./recordings/session.jsonl";
const SHOULD_RECORD = process.env.BT_RECORD === "true";
const BT_PREDICTOR_RAW =
    String(cliValue("predictor", "BT_PREDICTOR", "model1")).toLowerCase();
const BT_PREDICTOR =
    BT_PREDICTOR_RAW === "model7safe" ? "model7safe" : "model1";
const model7Runtime = createModel7Runtime();
const validationPairs = [];
let sessionStartMs = null;

if (
    SHOULD_RECORD &&
    path.basename(RECORDING_FILE) === "friday-peak.jsonl"
) {
    throw new Error(
        "Refusing to write BT_RECORD_FILE=friday-peak.jsonl. " +
        "Choose a new recordings/<day>.jsonl filename."
    );
}
if (
    BT_PREDICTOR_RAW !== "model1" &&
    BT_PREDICTOR_RAW !== "model7safe"
) {
    console.warn(
        `Unknown BT_PREDICTOR=${BT_PREDICTOR_RAW}; using model1`
    );
}

let replayCurrentTime = null;
const REPLAY_FILE =
    cliValue("replay-file", "BT_REPLAY_FILE", "./recordings/friday-peak.jsonl");
let replaySnapshots = null;
let replayIndex = 0;
let replayFinished = false;
let latestState = null;
let latestBuses = [];
let replayActiveIndex = -1;
let replayWallAnchor = null;
let replayTimeAnchor = null;
let replayPaused = false;
let replayRate = 1;
let replaySeekVersion = 0;
const sseClients = new Set();
let lastObservationFingerprint = "";

const uncertaintyBuckets = [
    { min: 0,  max: 10 },
    { min: 10, max: 20 },
    { min: 20, max: 30 },
    { min: 30, max: 60 },
    { min: 60, max: Infinity }
];


function getCurrentTime() {
    if (BT_MODE === "replay") {
        return replayCurrentTime;
    }

    return Date.now();
}

function recordSnapshot(buses) {
    if (!SHOULD_RECORD) {
        return;
    }

    const snapshot = {
        recordedAt: Date.now(),
        data: buses
    };

    fs.mkdirSync(path.dirname(RECORDING_FILE), { recursive: true });
    fs.appendFileSync(
        RECORDING_FILE,
        JSON.stringify(snapshot) + "\n"
    );
    console.log("recorded snapshot at", new Date(snapshot.recordedAt).toISOString());
}

async function getLiveBuses() {
    const response = await fetch(BT_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "json"
        }
    });

    const result = await response.json();

    if (SHOULD_RECORD) {
        recordSnapshot(result.data);
    }

    return result.data;
}

function loadReplaySnapshots() {
    const text =
        fs.readFileSync(REPLAY_FILE, "utf8");

    replaySnapshots = text
        .split("\n")
        .filter(line => line.trim() !== "")
        .map(line => JSON.parse(line));

    console.log(
        `Loaded ${replaySnapshots.length} replay snapshots`
    );
}

function normalizeRawBuses(rawBuses) {
    return rawBuses
        .filter(bus => bus.states && bus.states.length > 0)
        .map(bus => normalizeBus(bus));
}

function observationFingerprint(buses) {
    return buses
        .map(bus => `${bus.id}:${bus.version}:${bus.gtfsTripId}`)
        .sort()
        .join("|");
}

function publishState(force) {
    const fingerprint = observationFingerprint(latestBuses);
    if (!force && fingerprint === lastObservationFingerprint) {
        return false;
    }
    lastObservationFingerprint = fingerprint;
    buildLatestState(latestBuses);
    broadcastSse(latestState);
    return true;
}

function broadcastSse(state) {
    if (sseClients.size === 0 || !state) {
        return;
    }
    const payload = `data: ${JSON.stringify(state)}\n\n`;
    for (const client of sseClients) {
        client.write(payload);
    }
}

function ingestBusObservations(buses) {
    latestBuses = buses;
    if (sessionStartMs == null && buses.length > 0) {
        sessionStartMs = getCurrentTime();
    }
    updateBusStore(buses);

    for (const bus of buses) {
        const record = busStore.get(bus.id);

        if (
            record &&
            record.previous &&
            record.current.version === bus.version &&
            evaluatedVersions.get(bus.id) !== record.current.version
        ) {
            const evaluation =
                evaluatePrediction(
                    record.previous,
                    record.current
                );

            if (!evaluation) {
                if (
                    record.previous.gtfsTripId !==
                    record.current.gtfsTripId
                ) {
                    evaluatedVersions.set(
                        bus.id,
                        record.current.version
                    );
                }
            } else {
                predictionHistory.push(evaluation);
                if (predictionHistory.length > PREDICTION_HISTORY_LIMIT) {
                    predictionHistory.splice(
                        0,
                        predictionHistory.length - PREDICTION_HISTORY_LIMIT
                    );
                }
                validationPairs.push({
                    busId: evaluation.busId,
                    gtfsTripId: record.current.gtfsTripId,
                    deltaTimeSeconds: evaluation.deltaTimeSeconds,
                    baselineErrorMeters: evaluation.baselineErrorMeters,
                    model1ErrorMeters: evaluation.motionPredictionErrorMeters,
                    model7ErrorMeters: evaluation.model7PredictionErrorMeters,
                    model7FallbackUsed: evaluation.model7FallbackUsed,
                    model7FallbackReason: evaluation.model7FallbackReason,
                    model7Eligible: evaluation.model7Eligible === true,
                    model7HgbApplied: evaluation.model7HgbApplied === true,
                    model7AppliedCorrectionMeters:
                        evaluation.model7AppliedCorrectionMeters,
                    modelMode: evaluation.modelMode,
                    previousSpeed: evaluation.previousSpeed
                });

                evaluatedVersions.set(
                    bus.id,
                    record.current.version
                );

                const oracleText =
                    evaluation.oraclePredictionErrorMeters == null
                        ? "n/a"
                        : `${evaluation.oraclePredictionErrorMeters.toFixed(1)}m`;
                const cvText =
                    evaluation.constantPredictionErrorMeters == null
                        ? "n/a"
                        : `${evaluation.constantPredictionErrorMeters.toFixed(1)}m`;

                console.log(
                    `Bus ${evaluation.busId} | ` +
                    `${evaluation.transitionType} | ` +
                    `${evaluation.modelMode} | ` +
                    `Δt ${evaluation.deltaTimeSeconds.toFixed(1)}s | ` +
                    `Speed ${evaluation.previousSpeed.toFixed(1)}→${evaluation.currentSpeed.toFixed(1)} | ` +
                    `Baseline ${evaluation.baselineErrorMeters.toFixed(1)}m | ` +
                    `CV ${cvText} | ` +
                    `Motion ${evaluation.motionPredictionErrorMeters.toFixed(1)}m | ` +
                    `Oracle ${oracleText}`
                );
            }
        }

        model7Runtime.recordBus(bus);
    }
}

function replayBounds() {
    if (!replaySnapshots || replaySnapshots.length === 0) return null;
    return {
        startTime: replaySnapshots[0].recordedAt,
        endTime: replaySnapshots[replaySnapshots.length - 1].recordedAt
    };
}

function resetReplaySession() {
    busStore.clear();
    evaluatedVersions.clear();
    predictionHistory.length = 0;
    validationPairs.length = 0;
    sessionStartMs = null;
    model7Runtime.resetAll();
    lastObservationFingerprint = "";
}

function applyReplaySnapshot(index, currentTime) {
    const snapshot = replaySnapshots[index];
    replayCurrentTime = currentTime ?? snapshot.recordedAt;
    ingestBusObservations(normalizeRawBuses(snapshot.data));
}

function replayClockNow() {
    const bounds = replayBounds();
    if (!bounds) return null;
    if (replayCurrentTime == null || replayTimeAnchor == null || replayWallAnchor == null) {
        return bounds.startTime;
    }
    if (replayPaused) return replayCurrentTime;
    return Math.min(
        bounds.endTime,
        replayTimeAnchor + (Date.now() - replayWallAnchor) * replayRate
    );
}

function findReplayIndexAt(time) {
    let low = 0;
    let high = replaySnapshots.length - 1;
    let result = 0;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (replaySnapshots[middle].recordedAt <= time) {
            result = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return result;
}

function replayMetadata() {
    const bounds = replayBounds();
    if (!bounds) return null;
    const currentTime = replayClockNow() ?? bounds.startTime;
    const duration = Math.max(1, bounds.endTime - bounds.startTime);
    return {
        startTime: bounds.startTime,
        endTime: bounds.endTime,
        currentTime,
        progress: Math.max(0, Math.min(1, (currentTime - bounds.startTime) / duration)),
        isPlaying: !replayPaused,
        rate: replayRate,
        seekVersion: replaySeekVersion
    };
}

function seekReplay(progress) {
    if (!replaySnapshots) loadReplaySnapshots();
    const bounds = replayBounds();
    if (!bounds) return null;
    const normalizedProgress = Math.max(0, Math.min(1, Number(progress)));
    if (!Number.isFinite(normalizedProgress)) return null;

    const targetTime = bounds.startTime +
        normalizedProgress * (bounds.endTime - bounds.startTime);
    const index = findReplayIndexAt(targetTime);
    resetReplaySession();
    replayActiveIndex = index;
    replayPaused = true;
    replaySeekVersion += 1;
    replayWallAnchor = Date.now();
    replayTimeAnchor = targetTime;
    applyReplaySnapshot(index, targetTime);
    publishState(true);
    return replayMetadata();
}

function pauseReplay() {
    const currentTime = replayClockNow();
    if (currentTime == null) return null;
    replayCurrentTime = currentTime;
    replayTimeAnchor = currentTime;
    replayWallAnchor = Date.now();
    replayPaused = true;
    publishState(true);
    return replayMetadata();
}

function playReplay() {
    if (!replaySnapshots) loadReplaySnapshots();
    const bounds = replayBounds();
    if (!bounds) return null;
    if (replayActiveIndex < 0) seekReplay(0);
    replayCurrentTime = replayClockNow() ?? bounds.startTime;
    replayTimeAnchor = replayCurrentTime;
    replayWallAnchor = Date.now();
    replayPaused = false;
    publishState(true);
    return replayMetadata();
}

function setReplayRate(rate) {
    const nextRate = Number(rate);
    if (!Number.isFinite(nextRate) || nextRate < 0.25 || nextRate > 4) return null;
    const currentTime = replayClockNow();
    if (currentTime == null) return null;
    replayCurrentTime = currentTime;
    replayTimeAnchor = currentTime;
    replayWallAnchor = Date.now();
    replayRate = nextRate;
    publishState(true);
    return replayMetadata();
}

function replayTick() {
    if (!replaySnapshots) loadReplaySnapshots();
    const bounds = replayBounds();
    if (!bounds) return false;

    if (replayActiveIndex < 0) {
        replayActiveIndex = 0;
        replayWallAnchor = Date.now();
        replayTimeAnchor = bounds.startTime;
        applyReplaySnapshot(0, bounds.startTime);
        publishState(true);
        return true;
    }
    if (replayPaused) return false;

    const currentTime = replayClockNow();
    if (currentTime >= bounds.endTime) {
        console.log("--- Replay looping from start ---");
        resetReplaySession();
        replayActiveIndex = 0;
        replayWallAnchor = Date.now();
        replayTimeAnchor = bounds.startTime;
        applyReplaySnapshot(0, bounds.startTime);
        publishState(true);
        return true;
    }

    let applied = false;
    while (
        replayActiveIndex + 1 < replaySnapshots.length &&
        currentTime >= replaySnapshots[replayActiveIndex + 1].recordedAt
    ) {
        replayActiveIndex += 1;
        applyReplaySnapshot(replayActiveIndex, replaySnapshots[replayActiveIndex].recordedAt);
        applied = true;
    }
    if (applied) {
        replayCurrentTime = currentTime;
        replayTimeAnchor = currentTime;
        replayWallAnchor = Date.now();
        publishState(true);
    }
    return applied;
}

function getFreshness(version) {
    const delay = getCurrentTime() - version;
    if (delay < 15000) {
        return "fresh";
    } else if (delay < 30000) {
        return "recent";
    } else {
        return "stale";
    }
}

function normalizeBus(bus) {
    const state = bus.states[0];

    const freshness = getFreshness(state.version);
    const dataAge = (getCurrentTime() - state.version) / 1000;

    return {
        id: bus.id,
        routeId: bus.routeId,

        patternName: bus.patternName,

        latitude: state.latitude,
        longitude: state.longitude,

        speed: Number(state.speed),
        direction: Number(state.direction),
        gtfsTripId: bus.gtfsTripId,

        version: state.version,
        dataAge: dataAge,
        freshness: freshness,

        isBusAtStop: state.isBusAtStop === "Y"
    };
}

async function getNormalizedBuses() {
    const buses = await getLiveBuses();
    return normalizeRawBuses(buses);
}

function updateBusStore(buses) {
    for (const bus of buses) {

        const oldRecord = busStore.get(bus.id);

        if (!oldRecord) {
            busStore.set(bus.id, {
                current: bus,
                previous: null
            });

            continue;
        }

        if (bus.version !== oldRecord.current.version) {
            busStore.set(bus.id, {
                current: bus,
                previous: oldRecord.current
            });
        }
    }
}

function getTravelDirection(previousBus, currentBus) {
    const previousProgress = getRouteProgress(
        previousBus.gtfsTripId,
        previousBus.latitude,
        previousBus.longitude
    );

    const currentProgress = getRouteProgress(
        currentBus.gtfsTripId,
        currentBus.latitude,
        currentBus.longitude
    );

    if (!previousProgress || !currentProgress) {
        return null;
    }

    if (
        currentProgress.progressKm >
        previousProgress.progressKm
    ) {
        return 1;
    }

    if (
        currentProgress.progressKm <
        previousProgress.progressKm
    ) {
        return -1;
    }

    return 0;
}

function predictBusPosition(currentBus) {
    const dataAgeSeconds =
        (getCurrentTime() - currentBus.version) / 1000;

    return predictBusAfterSeconds(
        currentBus,
        dataAgeSeconds
    );
}

function predictBusAfterSeconds(bus, seconds) {
    const currentProgress =
        getDirectedRouteProgress(
            bus.gtfsTripId,
            bus.latitude,
            bus.longitude,
            bus.direction
        );

    if (!currentProgress) {
        return null;
    }

    const predictedDistanceKm =
        bus.speed *
        seconds /
        1000;

    // Loop vs non-loop is handled inside getRoutePoint:
    // loops wrap, non-loops clamp at the endpoint.
    const predictedProgressKm =
        currentProgress.progressKm +
        predictedDistanceKm;

    const predictedPoint =
        getRoutePoint(
            bus.gtfsTripId,
            predictedProgressKm
        );

    if (!predictedPoint) {
        return null;
    }

    return {
        latitude: predictedPoint.latitude,
        longitude: predictedPoint.longitude,
        // Use the loop-wrapped / non-loop-clamped progress from getRoutePoint.
        progressKm: predictedPoint.progressKm,

        snappedProgressKm:
            currentProgress.progressKm,

        snappedDistanceMeters:
            currentProgress.distanceMeters,

        segmentIndex:
            currentProgress.segmentIndex,

        headingDifference:
            currentProgress.directionDifference
    };
}

function predictBusAfterSecondsMotionAware(
    bus,
    seconds
) {
    if (bus.speed <= 1) {
        return {
            latitude: bus.latitude,
            longitude: bus.longitude,

            progressKm: null,
            snappedProgressKm: null,
            snappedDistanceMeters: 0,
            segmentIndex: null,
            headingDifference: null,

            modelMode: "hold"
        };
    }

    const prediction =
        predictBusAfterSeconds(
            bus,
            seconds
        );

    if (!prediction) {
        return null;
    }

    return {
        ...prediction,
        modelMode: "moving"
    };
}

function predictBusAfterSecondsWithSpeed(
    bus,
    seconds,
    speed
) {
    const modifiedBus = {
        ...bus,
        speed: speed
    };

    return predictBusAfterSeconds(
        modifiedBus,
        seconds
    );
}

function percentile(values, p) {
    if (values.length === 0) {
        return null;
    }

    const sorted = [...values].sort((a, b) => a - b);

    const index =
        Math.ceil((p / 100) * sorted.length) - 1;

    return sorted[
        Math.max(0, Math.min(index, sorted.length - 1))
    ];
}

function evaluatePrediction(previous, current) {

    if (previous.gtfsTripId !== current.gtfsTripId) {
        console.log(
            `Skip eval bus ${current.id}: trip changed ` +
            `${previous.gtfsTripId} → ${current.gtfsTripId}`
        );
        return null;
    }

    const deltaTimeSeconds =
        (current.version - previous.version) / 1000;

    if (deltaTimeSeconds <= 0) {
        return null;
    }

    const motionPrediction =
        predictBusAfterSecondsMotionAware(
            previous,
            deltaTimeSeconds
        );

    // Production model is motion-aware (hold or moving).
    // Do not drop the sample just because CV or the speed oracle failed.
    if (!motionPrediction) {
        return null;
    }

    const constantPrediction =
        predictBusAfterSeconds(
            previous,
            deltaTimeSeconds
        );

    const oracleSpeed =
        (previous.speed + current.speed) / 2;
    const oraclePrediction =
        predictBusAfterSecondsWithSpeed(
            previous,
            deltaTimeSeconds,
            oracleSpeed
        );

    const previousPoint = turf.point([
        previous.longitude,
        previous.latitude
    ]);

    const motionPredictedPoint =
        turf.point([
            motionPrediction.longitude,
            motionPrediction.latitude
        ]);

    const actualPoint = turf.point([
        current.longitude,
        current.latitude
    ]);

    const baselineErrorMeters =
        turf.distance(
            previousPoint,
            actualPoint,
            { units: "kilometers" }
        ) * 1000;

    let transitionType;

    if (baselineErrorMeters < 2) {
        transitionType = "no_observed_movement";
    } else if (baselineErrorMeters < 10) {
        transitionType = "small_observed_movement";
    } else {
        transitionType = "confirmed_movement";
    }

    const motionPredictionErrorMeters =
        turf.distance(
            motionPredictedPoint,
            actualPoint,
            { units: "kilometers" }
        ) * 1000;

    const model7Result = model7Runtime.predictSafe(
        previous,
        deltaTimeSeconds,
        { trackStats: false }
    );
    let model7ErrorMeters = null;
    const model7Prediction = model7Result.prediction || motionPrediction;
    if (model7Prediction) {
        const model7Point = turf.point([
            model7Prediction.longitude,
            model7Prediction.latitude
        ]);
        model7ErrorMeters =
            turf.distance(
                model7Point,
                actualPoint,
                { units: "kilometers" }
            ) * 1000;
    }

    let constantPredictionErrorMeters = null;
    if (constantPrediction) {
        const constantPredictedPoint =
            turf.point([
                constantPrediction.longitude,
                constantPrediction.latitude
            ]);

        constantPredictionErrorMeters =
            turf.distance(
                constantPredictedPoint,
                actualPoint,
                { units: "kilometers" }
            ) * 1000;
    }

    let oraclePredictionErrorMeters = null;

    if (oraclePrediction) {
        const oraclePredictedPoint =
            turf.point([
                oraclePrediction.longitude,
                oraclePrediction.latitude
            ]);

        oraclePredictionErrorMeters =
            turf.distance(
                oraclePredictedPoint,
                actualPoint,
                { units: "kilometers" }
            ) * 1000;
    }

    return {
        busId: current.id,

        deltaTimeSeconds,

        baselineErrorMeters,

        constantPredictionErrorMeters,
        motionPredictionErrorMeters,
        oraclePredictionErrorMeters,
        oracleSpeed: oraclePrediction ? oracleSpeed : null,

        model7PredictionErrorMeters:
            model7ErrorMeters,
        model7FallbackUsed:
            model7Result ? model7Result.fallbackUsed : true,
        model7FallbackReason:
            model7Result ? model7Result.fallbackReason : "unavailable",
        model7Eligible: isModel7EligibleTrip(previous.gtfsTripId),
        model7HgbApplied: model7Result ? model7Result.hgbApplied === true : false,
        model7AppliedCorrectionMeters:
            model7Result ? model7Result.appliedCorrectionMeters : 0,

        constantImprovementMeters:
            constantPredictionErrorMeters == null
                ? null
                : baselineErrorMeters -
                    constantPredictionErrorMeters,

        motionImprovementMeters:
            baselineErrorMeters -
            motionPredictionErrorMeters,

        transitionType,

        previousSpeed: previous.speed,
        currentSpeed: current.speed,

        previousIsBusAtStop:
            previous.isBusAtStop,

        currentIsBusAtStop:
            current.isBusAtStop,

        modelMode:
            motionPrediction.modelMode
    };
}

function getUncertaintyCalibration() {
    return uncertaintyBuckets.map(bucket => {

        const samples = predictionHistory.filter(evaluation =>
            evaluation.deltaTimeSeconds >= bucket.min &&
            evaluation.deltaTimeSeconds < bucket.max &&
            evaluation.transitionType === "confirmed_movement"
        );

        const errors = samples.map(
            evaluation =>
                evaluation.motionPredictionErrorMeters
        );

        return {
            minSeconds: bucket.min,
            maxSeconds: bucket.max,
            sampleCount: errors.length,

            p50Meters: percentile(errors, 50),
            p80Meters: percentile(errors, 80),
            p95Meters: percentile(errors, 95)
        };
    });
}

function printUncertaintyCalibration() {
    const calibration =
        getUncertaintyCalibration();

    console.log("\n--- Uncertainty Calibration ---");

    for (const bucket of calibration) {

        const label =
            bucket.maxSeconds === Infinity
                ? `${bucket.minSeconds}s+`
                : `${bucket.minSeconds}-${bucket.maxSeconds}s`;

        if (bucket.sampleCount === 0) {
            console.log(
                `${label}: no samples`
            );
            continue;
        }

        console.log(
            `${label} | n=${bucket.sampleCount}` +
            ` | P50=${bucket.p50Meters.toFixed(1)}m` +
            ` | P80=${bucket.p80Meters.toFixed(1)}m` +
            ` | P95=${bucket.p95Meters.toFixed(1)}m`
        );
    }

    console.log("-------------------------------\n");
}

function getP80ForHorizon(deltaTimeSeconds) {
    const calibration = getUncertaintyCalibration();

    let matched = null;
    for (const bucket of calibration) {
        if (
            deltaTimeSeconds >= bucket.minSeconds &&
            deltaTimeSeconds < bucket.maxSeconds
        ) {
            matched = bucket;
            break;
        }
    }

    if (matched && matched.p80Meters != null) {
        return matched.p80Meters;
    }

    const withSamples = calibration.filter(
        bucket => bucket.p80Meters != null
    );

    if (withSamples.length === 0) {
        return 40;
    }

    return withSamples[withSamples.length - 1].p80Meters;
}

function buildRouteAlignedUncertainty(
    gtfsTripId,
    progressKm,
    p80Meters
) {
    if (
        progressKm === null ||
        progressKm === undefined ||
        !Number.isFinite(p80Meters)
    ) {
        return null;
    }

    const deltaKm = p80Meters / 1000;
    const samples = [];
    const stepKm = 0.003;
    const startKm = progressKm - deltaKm;
    const endKm = progressKm + deltaKm;

    for (let p = startKm; p <= endKm + 1e-9; p += stepKm) {
        const point = getRoutePoint(
            gtfsTripId,
            p
        );
        if (point) {
            samples.push([point.longitude, point.latitude]);
        }
    }

    if (samples.length < 2) {
        return null;
    }

    return samples;
}

function summarizeNextStop(stopInfo) {
    if (!stopInfo) {
        return null;
    }

    return {
        stopId: stopInfo.stopId,
        stopName: stopInfo.stopName,
        distanceMeters: stopInfo.distanceMeters,
        arrivalTime: stopInfo.arrivalTime,
        timepoint: stopInfo.timepoint,
        scheduledOnly: true
    };
}

function productionPredict(bus, dataAgeSeconds) {
    const model1 = predictBusAfterSecondsMotionAware(
        bus,
        dataAgeSeconds
    );

    if (BT_PREDICTOR !== "model7safe") {
        return {
            prediction: model1,
            fallbackUsed: false,
            fallbackReason: null,
            holdSkipHgb: bus.speed <= 1,
            rawMlResidualMeters: null,
            clampedMlResidualMeters: null,
            appliedCorrectionMeters: 0,
            correctionScale: 0.5,
            startProgressKm: model1
                ? model1.snappedProgressKm
                : null,
            mlModelType: null
        };
    }

    const model7 = model7Runtime.predictSafe(bus, dataAgeSeconds);
    if (model7.fallbackUsed || !model7.prediction) {
        return {
            prediction: model1,
            fallbackUsed: true,
            fallbackReason: model7.fallbackReason || "model7_unavailable",
            holdSkipHgb: false,
            rawMlResidualMeters: model7.rawMlResidualMeters,
            clampedMlResidualMeters: model7.clampedMlResidualMeters,
            appliedCorrectionMeters: 0,
            correctionScale: 0.5,
            startProgressKm: model1
                ? model1.snappedProgressKm
                : null,
            mlModelType: "route_hgb_residual_safe"
        };
    }

    return {
        prediction: model7.prediction,
        fallbackUsed: false,
        fallbackReason: null,
        holdSkipHgb: model7.holdSkipHgb,
        rawMlResidualMeters: model7.rawMlResidualMeters,
        clampedMlResidualMeters: model7.clampedMlResidualMeters,
        appliedCorrectionMeters: model7.appliedCorrectionMeters,
        correctionScale: model7.correctionScale,
        startProgressKm: model7.startProgressKm,
        mlModelType: "route_hgb_residual_safe"
    };
}

function buildBusPayload(bus) {
    const dataAgeSeconds =
        (getCurrentTime() - bus.version) / 1000;

    const produced = productionPredict(bus, dataAgeSeconds);
    const prediction = produced.prediction;

    const directedProgress =
        getDirectedRouteProgress(
            bus.gtfsTripId,
            bus.latitude,
            bus.longitude,
            bus.direction
        );

    const progressKm =
        prediction?.progressKm ??
        directedProgress?.progressKm ??
        null;

    const p80Meters = getP80ForHorizon(dataAgeSeconds);
    const routeAlignedCoordinates =
        progressKm != null
            ? buildRouteAlignedUncertainty(
                bus.gtfsTripId,
                progressKm,
                p80Meters
            )
            : null;

    const nextStop = summarizeNextStop(
        progressKm != null
            ? getNextStopInfo(bus.gtfsTripId, progressKm)
            : null
    );

    const upcomingTurn =
        progressKm != null
            ? getUpcomingTurnInfo(
                bus.gtfsTripId,
                progressKm,
                250
            )
            : null;

    return {
        id: bus.id,
        routeId: bus.routeId,
        patternName: bus.patternName,
        gtfsTripId: bus.gtfsTripId,
        ...getRouteStyle(bus.gtfsTripId, bus.routeId),
        generatedAt: Date.now(),
        observationVersion: bus.version,
        reported: {
            latitude: bus.latitude,
            longitude: bus.longitude,
            version: bus.version,
            speed: bus.speed,
            direction: bus.direction,
            dataAge: dataAgeSeconds,
            freshness: bus.freshness
        },
        predicted: prediction
            ? {
                latitude: prediction.latitude,
                longitude: prediction.longitude,
                predictionHorizonSeconds: dataAgeSeconds,
                modelMode: prediction.modelMode,
                progressKm: prediction.progressKm
            }
            : null,
        predictionState: {
            modelType: "route_constant_velocity",
            modelMode:
                prediction?.modelMode ||
                (bus.speed <= 1 ? "hold" : "moving"),
            startProgressKm:
                produced.startProgressKm ??
                directedProgress?.progressKm ??
                null,
            startTimestamp: Date.now(),
            initialElapsedSeconds: dataAgeSeconds,
            speedMetersPerSecond: bus.speed,
            routeLengthKm: getRouteLengthKm(bus.gtfsTripId),
            loop: isLoopTrip(bus.gtfsTripId),
            mlModelType: produced.mlModelType,
            baseModel: "route_constant_velocity",
            rawMlResidualMeters: produced.rawMlResidualMeters,
            clampedMlResidualMeters: produced.clampedMlResidualMeters,
            appliedCorrectionMeters: produced.appliedCorrectionMeters,
            correctionScale: produced.correctionScale,
            fallbackUsed: produced.fallbackUsed,
            fallbackReason: produced.fallbackReason,
            holdSkipHgb: produced.holdSkipHgb
        },
        speed: bus.speed,
        direction: bus.direction,
        version: bus.version,
        dataAge: dataAgeSeconds,
        freshness: bus.freshness,
        isBusAtStop: bus.isBusAtStop,
        predictionHorizonSeconds: dataAgeSeconds,
        nextStop,
        upcomingTurn,
        uncertainty: {
            p80Meters,
            kind: routeAlignedCoordinates
                ? "route_aligned"
                : "historical_error_radius",
            label: "historical prediction error / approximate uncertainty",
            routeCoordinates: routeAlignedCoordinates
        }
    };
}

function meanOf(values) {
    if (values.length === 0) {
        return null;
    }

    let total = 0;
    for (const value of values) {
        total += value;
    }
    return total / values.length;
}

function getModelComparisonStats() {
    if (predictionHistory.length === 0) {
        return null;
    }

    const tieToleranceMeters = 1;
    let totalBaselineError = 0;
    let totalMotionError = 0;
    let totalConstantError = 0;
    let constantCount = 0;
    let totalOracleError = 0;
    let oracleCount = 0;

    let constantWins = 0;
    let constantTies = 0;
    let constantLosses = 0;

    let motionWins = 0;
    let motionTies = 0;
    let motionLosses = 0;

    for (const sample of predictionHistory) {
        totalBaselineError += sample.baselineErrorMeters;
        totalMotionError += sample.motionPredictionErrorMeters;

        if (sample.constantPredictionErrorMeters != null) {
            totalConstantError += sample.constantPredictionErrorMeters;
            constantCount++;

            const constantDifference =
                sample.constantPredictionErrorMeters -
                sample.baselineErrorMeters;

            if (constantDifference < -tieToleranceMeters) {
                constantWins++;
            } else if (Math.abs(constantDifference) <= tieToleranceMeters) {
                constantTies++;
            } else {
                constantLosses++;
            }
        }

        if (sample.oraclePredictionErrorMeters != null) {
            totalOracleError += sample.oraclePredictionErrorMeters;
            oracleCount++;
        }

        const motionDifference =
            sample.motionPredictionErrorMeters -
            sample.baselineErrorMeters;

        if (motionDifference < -tieToleranceMeters) {
            motionWins++;
        } else if (Math.abs(motionDifference) <= tieToleranceMeters) {
            motionTies++;
        } else {
            motionLosses++;
        }
    }

    const count = predictionHistory.length;

    const groups = {};
    for (const type of [
        "confirmed_movement",
        "small_observed_movement",
        "no_observed_movement"
    ]) {
        const samples = predictionHistory.filter(
            sample => sample.transitionType === type
        );

        if (samples.length === 0) {
            continue;
        }

        const constantErrors = samples
            .map(sample => sample.constantPredictionErrorMeters)
            .filter(value => value != null);
        let oracleTotal = 0;
        let oracleSamples = 0;
        let constantImproved = 0;
        let motionImproved = 0;

        for (const sample of samples) {
            if (sample.oraclePredictionErrorMeters != null) {
                oracleTotal += sample.oraclePredictionErrorMeters;
                oracleSamples++;
            }
            if (
                sample.constantPredictionErrorMeters != null &&
                sample.constantPredictionErrorMeters < sample.baselineErrorMeters
            ) {
                constantImproved++;
            }
            if (sample.motionPredictionErrorMeters < sample.baselineErrorMeters) {
                motionImproved++;
            }
        }

        groups[type] = {
            samples: samples.length,
            avgBaselineMeters: meanOf(
                samples.map(sample => sample.baselineErrorMeters)
            ),
            avgConstantMeters: meanOf(constantErrors),
            avgMotionMeters: meanOf(
                samples.map(sample => sample.motionPredictionErrorMeters)
            ),
            avgOracleMeters:
                oracleSamples > 0
                    ? oracleTotal / oracleSamples
                    : null,
            constantImproved,
            motionImproved
        };
    }

    return {
        samples: count,
        avgBaselineMeters: totalBaselineError / count,
        avgConstantMeters:
            constantCount > 0
                ? totalConstantError / constantCount
                : null,
        avgMotionMeters: totalMotionError / count,
        avgOracleMeters:
            oracleCount > 0
                ? totalOracleError / oracleCount
                : null,
        oracleSamples: oracleCount,
        constant: {
            wins: constantWins,
            ties: constantTies,
            losses: constantLosses
        },
        motion: {
            wins: motionWins,
            ties: motionTies,
            losses: motionLosses
        },
        groups
    };
}

function publicEvaluationStats() {
    const stats = getModelComparisonStats();
    if (!stats) {
        return null;
    }

    const groups = {};
    for (const [type, group] of Object.entries(stats.groups)) {
        groups[type] = {
            samples: group.samples,
            avgBaselineMeters: group.avgBaselineMeters,
            avgConstantMeters: group.avgConstantMeters,
            avgMotionMeters: group.avgMotionMeters,
            constantImproved: group.constantImproved,
            motionImproved: group.motionImproved
        };
    }

    return {
        samples: stats.samples,
        avgBaselineMeters: stats.avgBaselineMeters,
        avgConstantMeters: stats.avgConstantMeters,
        avgMotionMeters: stats.avgMotionMeters,
        constant: stats.constant,
        motion: stats.motion,
        groups
    };
}

function validationPayload() {
    return buildValidationPayload({
        sessionStartMs,
        computedAtMs: Date.now(),
        predictorConfigured: BT_PREDICTOR,
        pairs: validationPairs,
        predictorStats: model7Runtime.stats()
    });
}

function publicModel7Validation() {
    const cas = validationPayload().model7EligibleCas;
    const available = cas.completedPairCount > 0;

    return {
        available,
        predictorConfigured: BT_PREDICTOR,
        mapUsesModel7Safe: BT_PREDICTOR === "model7safe",
        scope: "cas_gtfs_route_id",
        gtfsRouteId: "CAS",
        completedPairCount: cas.completedPairCount,
        nHold: cas.nHold,
        nMoving: cas.nMoving,
        staleMeanGeoErrorMeters:
            cas.stalePositionBaseline.meanGeoErrorMeters,
        model1MeanGeoErrorMeters: cas.model1.meanGeoErrorMeters,
        model7SafeMeanGeoErrorMeters:
            cas.model7safe.meanGeoErrorMeters,
        improvementVsModel1MeanGeoErrorMeters:
            cas.improvementVsModel1.meanGeoErrorMeters,
        movingOnly: {
            completedPairCount: cas.movingOnly.completedPairCount,
            model1MeanGeoErrorMeters:
                cas.movingOnly.model1.meanGeoErrorMeters,
            model7SafeMeanGeoErrorMeters:
                cas.movingOnly.model7safe.meanGeoErrorMeters,
            improvementVsModel1MeanGeoErrorMeters:
                cas.movingOnly.improvementVsModel1.meanGeoErrorMeters
        }
    };
}

function buildLatestState(buses) {
    const generatedAt = Date.now();
    latestState = {
        timestamp: generatedAt,
        generatedAt,
        sourceMode: BT_MODE,
        mode: BT_MODE,
        recording: SHOULD_RECORD,
        serverTime: getCurrentTime(),
        replay: BT_MODE === "replay" ? replayMetadata() : null,
        buses: buses.map(buildBusPayload),
        evaluation: publicEvaluationStats(),
        model7Validation: publicModel7Validation(),
        uncertaintyCalibration: getUncertaintyCalibration()
    };
}

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon"
};

function applyCors(req, res) {
    const configured = process.env.CORS_ORIGIN || "*";
    const origin = req.headers.origin;
    let allow = "*";
    if (configured !== "*") {
        const list = configured.split(",").map((item) => item.trim()).filter(Boolean);
        if (origin && list.includes(origin)) allow = origin;
        else if (list.length === 1) allow = list[0];
    }
    res.setHeader("Access-Control-Allow-Origin", allow);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin":
            res.getHeader("Access-Control-Allow-Origin") || "*"
    });
    res.end(payload);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", chunk => {
            body += chunk;
            if (body.length > 100_000) {
                reject(new Error("Request body is too large"));
                req.destroy();
            }
        });
        req.on("end", () => {
            if (!body.trim()) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error("Request body must be valid JSON"));
            }
        });
        req.on("error", reject);
    });
}

function handleReplayControl(action, body) {
    if (action === "seek") return seekReplay(body.progress);
    if (action === "pause") return pauseReplay();
    if (action === "play") return playReplay();
    if (action === "rate") return setReplayRate(body.rate);
    return null;
}

function serveStatic(req, res) {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    let pathname = requestUrl.pathname;
    if (pathname === "/") {
        pathname = "/index.html";
    }

    const filePath = path.normalize(
        path.join(PUBLIC_DIR, pathname)
    );

    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end("Not found");
            return;
        }

        const ext = path.extname(filePath);
        res.writeHead(200, {
            "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
            "Cache-Control": "no-store"
        });
        res.end(data);
    });
}

function startHttpServer() {
    const server = http.createServer(async (req, res) => {
        applyCors(req, res);
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);

        if (requestUrl.pathname.startsWith("/api/replay/")) {
            if (BT_MODE !== "replay") {
                sendJson(res, 409, { error: "Replay controls require BT_MODE=replay" });
                return;
            }
            if (req.method !== "POST") {
                sendJson(res, 405, { error: "Use POST for replay controls" });
                return;
            }
            try {
                const action = requestUrl.pathname.split("/").pop();
                const replay = handleReplayControl(action, await readJsonBody(req));
                if (!replay) {
                    sendJson(res, 400, { error: "Invalid replay control request" });
                    return;
                }
                sendJson(res, 200, { replay });
            } catch (error) {
                sendJson(res, 400, { error: error.message || "Invalid replay request" });
            }
            return;
        }

        if (requestUrl.pathname === "/api/state") {
            if (!latestState) {
                buildLatestState(latestBuses);
            }
            sendJson(res, 200, latestState || {
                timestamp: getCurrentTime(),
                sourceMode: BT_MODE,
                mode: BT_MODE,
                recording: SHOULD_RECORD,
                serverTime: getCurrentTime(),
                replay: BT_MODE === "replay" ? replayMetadata() : null,
                buses: [],
                evaluation: null,
                model7Validation: publicModel7Validation(),
                uncertaintyCalibration: []
            });
            return;
        }

        if (requestUrl.pathname === "/api/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
                "Access-Control-Allow-Origin":
                    res.getHeader("Access-Control-Allow-Origin") || "*"
            });
            res.write("\n");
            sseClients.add(res);
            if (latestState) {
                res.write(`data: ${JSON.stringify(latestState)}\n\n`);
            }
            req.on("close", () => {
                sseClients.delete(res);
            });
            return;
        }

        if (requestUrl.pathname === "/api/validation") {
            sendJson(res, 200, validationPayload());
            return;
        }

        if (requestUrl.pathname === "/api/route") {
            const tripId = requestUrl.searchParams.get("tripId");
            const coordinates = tripId
                ? getRouteGeometry(tripId)
                : null;
            sendJson(res, 200, {
                gtfsTripId: tripId,
                coordinates,
                ...getRouteStyle(tripId)
            });
            return;
        }

        serveStatic(req, res);
    });

    server.listen(PORT, "0.0.0.0", () => {
        console.log(
            `BT+ server ${BT_MODE} on http://localhost:${PORT}` +
            ` | predictor=${BT_PREDICTOR}` +
            ` | recording=${SHOULD_RECORD}`
        );
    });
}


//test functions//////
function testTravelDirection(record) {
    const previous = record.previous;
    const current = record.current;

    if (!previous || !current) {
        return;
    }

    if (previous.gtfsTripId !== current.gtfsTripId) {
        return;
    }

    const previousProgress = getRouteProgress(
        previous.gtfsTripId,
        previous.latitude,
        previous.longitude
    );

    const currentProgress = getRouteProgress(
        current.gtfsTripId,
        current.latitude,
        current.longitude
    );

    if (!previousProgress || !currentProgress) {
        return;
    }

    const direction =
        getTravelDirection(previous, current);

    console.log(
        `Bus ${current.id} | ` +
        `Previous ${previousProgress.progressKm.toFixed(3)} km | ` +
        `Current ${currentProgress.progressKm.toFixed(3)} km | ` +
        `Direction ${direction}`
    );
}
function testSpeedUnit(record) {

    const current = record.current;
    const previous = record.previous;

    if (!current || !previous) {
        return;
    }

    // 必须还是同一个 trip
    if (current.gtfsTripId !== previous.gtfsTripId) {
        return;
    }

    const currentProgress = getRouteProgress(
        current.gtfsTripId,
        current.latitude,
        current.longitude
    );

    const previousProgress = getRouteProgress(
        previous.gtfsTripId,
        previous.latitude,
        previous.longitude
    );

    if (!currentProgress || !previousProgress) {
        return;
    }

    const deltaTimeSeconds =
        (current.version - previous.version) / 1000;

    if (deltaTimeSeconds <= 0) {
        return;
    }

    let deltaDistanceKm =
        currentProgress.progressKm -
        previousProgress.progressKm;

    if (deltaDistanceKm < 0.02) {
        return;
    }

    const observedSpeedMps =
        deltaDistanceKm * 1000 / deltaTimeSeconds;
    const apiAverageSpeed =
        (previous.speed + current.speed) / 2;
            if (apiAverageSpeed <= 0) {
        return;
    }

    const ratio =
        observedSpeedMps / apiAverageSpeed;

    if (current.id === "7006") {
        console.log("\n========== BUS 7006 ==========");

        console.log(
            "Previous GPS:",
            previous.latitude,
            previous.longitude
        );

        console.log(
            "Current GPS:",
            current.latitude,
            current.longitude
        );

        console.log(
            "Previous progress:",
            previousProgress.progressKm,
            "km"
        );

        console.log(
            "Current progress:",
            currentProgress.progressKm,
            "km"
        );

        console.log(
            "Route length:",
            currentProgress.routeLengthKm,
            "km"
        );

        console.log(
            "Previous distance from route:",
            previousProgress.distanceFromRouteKm * 1000,
            "m"
        );

        console.log(
            "Current distance from route:",
            currentProgress.distanceFromRouteKm * 1000,
            "m"
        );

        console.log(
            "Delta time:",
            deltaTimeSeconds,
            "seconds"
        );

        console.log(
            "Calculated distance:",
            deltaDistanceKm * 1000,
            "m"
        );

        console.log(
            "API average speed:",
            apiAverageSpeed,
            "m/s"
        );

        console.log(
            "Observed speed:",
            observedSpeedMps,
            "m/s"
        );
    }
}
function testPrediction(record) {
    const previous = record.previous;
    const current = record.current;

    if (!previous || !current) {
        return;
    }

    if (previous.gtfsTripId !== current.gtfsTripId) {
        return;
    }

    const prediction =
        predictBusPosition(previous, current);

    if (!prediction) {
        return;
    }

    const reportedPoint = turf.point([
    current.longitude,
    current.latitude
    ]);

    const predictedPoint = turf.point([
        prediction.longitude,
        prediction.latitude
    ]);

    const predictionDistanceMeters =
    turf.distance(
        reportedPoint,
        predictedPoint,
        { units: "kilometers" }
    ) * 1000;

    const dataAge =
        (Date.now() - current.version) / 1000;

    console.log(
        `Bus ${current.id} | ` +
        `Age ${dataAge.toFixed(1)}s | ` +
        `Speed ${current.speed.toFixed(1)}m/s | ` +
        `Moved ${predictionDistanceMeters.toFixed(1)}m | ` +
        `Reported (${current.latitude}, ${current.longitude}) | ` +
        `Predicted (${prediction.latitude.toFixed(6)}, ${prediction.longitude.toFixed(6)})`
    );
}
function testDirectedSnap(record) {
    const current = record.current;

    if (!current) return;

    const normal = getRouteProgress(
        current.gtfsTripId,
        current.latitude,
        current.longitude
    );

    const directed = getDirectedRouteProgress(
        current.gtfsTripId,
        current.latitude,
        current.longitude,
        current.direction
    );

    if (!normal || !directed) {
        return;
    }

    console.log(
        `Bus ${current.id} | ` +
        `Heading ${current.direction.toFixed(0)}° | ` +
        `Normal ${normal.progressKm.toFixed(3)}km | ` +
        `Directed ${directed.progressKm.toFixed(3)}km | ` +
        `Segment ${directed.segmentIndex} | ` +
        `SegHeading ${directed.segmentBearing.toFixed(0)}° | ` +
        `Diff ${directed.directionDifference.toFixed(0)}° | ` +
        `RouteDist ${directed.distanceMeters.toFixed(1)}m`
    );
}
//////
function normalizeBearing(angle) {
    return (angle + 360) % 360;
}

function bearingDifference(a, b) {
    const diff = Math.abs(
        normalizeBearing(a) - normalizeBearing(b)
    );

    return Math.min(diff, 360 - diff);
}

function testDirection(record) {
    const current = record.current;
    const previous = record.previous;

    if (!current || !previous) return;

    if (current.gtfsTripId !== previous.gtfsTripId) {
        return;
    }

    // GPS基本没动时，算出来的方向没有意义
    const from = turf.point([
        previous.longitude,
        previous.latitude
    ]);

    const to = turf.point([
        current.longitude,
        current.latitude
    ]);

    const distanceMeters =
        turf.distance(from, to, {
            units: "kilometers"
        }) * 1000;

    if (distanceMeters < 20) {
        return;
    }

    const observedBearing =
        normalizeBearing(
            turf.bearing(from, to)
        );

    const apiDirection =
        normalizeBearing(current.direction);

    const difference =
        bearingDifference(
            observedBearing,
            apiDirection
        );

    console.log(
        `Bus ${current.id} | ` +
        `API ${apiDirection.toFixed(1)}° | ` +
        `GPS ${observedBearing.toFixed(1)}° | ` +
        `Diff ${difference.toFixed(1)}° | ` +
        `Moved ${distanceMeters.toFixed(1)}m`
    );
}
// function testRouteAmbiguity(record) {
//     const current = record.current;
//     const previous = record.previous;

//     if (!current || !previous) return;

//     if (
//         current.gtfsTripId !==
//         previous.gtfsTripId
//     ) {
//         return;
//     }

//     const candidates = checkRouteAmbiguity(
//         current.gtfsTripId,
//         current.latitude,
//         current.longitude
//     );

//     if (!candidates || candidates.length < 2) {
//         return;
//     }

//     const best = candidates[0];

//     // 找另一个：
//     // 1. 也离 GPS 很近（20m以内）
//     // 2. 但 route progress 和最佳点差至少 200m
//     const competing = candidates.find(candidate =>
//         candidate.segment !== best.segment &&
//         candidate.distanceMeters < 20 &&
//         Math.abs(
//             candidate.progressKm -
//             best.progressKm
//         ) > 0.2
//     );

//     if (!competing) return;

//     console.log("\n========== ROUTE AMBIGUITY ==========");

//     console.log(
//         `Bus ${current.id} | Route ${current.routeId}`
//     );

//     console.log(
//         `GPS: ${current.latitude}, ${current.longitude}`
//     );

//     console.log(
//         `API speed: ${current.speed} m/s`
//     );

//     console.log("Best candidate:", best);

//     console.log(
//         "Competing candidate:",
//         competing
//     );

//     console.log("Top 5:", candidates);
// }

function printPredictionStats() {
    const stats = getModelComparisonStats();

    if (!stats) {
        return;
    }

    console.log("\n--- Model Comparison ---");
    console.log(`Samples: ${stats.samples}`);
    console.log(`Baseline: ${stats.avgBaselineMeters.toFixed(1)}m`);
    console.log(
        `Constant velocity: ${
            stats.avgConstantMeters == null
                ? "n/a"
                : `${stats.avgConstantMeters.toFixed(1)}m`
        }`
    );
    console.log(`Motion-aware: ${stats.avgMotionMeters.toFixed(1)}m`);
    console.log(
        `CV: ${stats.constant.wins}W / ${stats.constant.ties}T / ${stats.constant.losses}L`
    );
    console.log(
        `Motion: ${stats.motion.wins}W / ${stats.motion.ties}T / ${stats.motion.losses}L`
    );
    if (stats.avgOracleMeters != null) {
        console.log(
            `Speed oracle (eval only): ${stats.avgOracleMeters.toFixed(1)}m`
        );
    }

    for (const [type, group] of Object.entries(stats.groups)) {
        console.log(`\n${type}:`);
        console.log(`  Samples: ${group.samples}`);
        console.log(`  Baseline: ${group.avgBaselineMeters.toFixed(1)}m`);
        console.log(
            `  CV: ${
                group.avgConstantMeters == null
                    ? "n/a"
                    : `${group.avgConstantMeters.toFixed(1)}m`
            }`
        );
        console.log(`  Motion: ${group.avgMotionMeters.toFixed(1)}m`);
        console.log(
            `  CV improved: ${group.constantImproved}/${group.samples}`
        );
        console.log(
            `  Motion improved: ${group.motionImproved}/${group.samples}`
        );
        if (group.avgOracleMeters != null) {
            console.log(
                `  Oracle (eval only): ${group.avgOracleMeters.toFixed(1)}m`
            );
        }
    }

    console.log("------------------------\n");
}

async function update() {
    try {
        if (BT_MODE === "replay") {
            replayTick();
        } else {
            const buses = await getNormalizedBuses();
            ingestBusObservations(buses);
            publishState(BT_PREDICTOR === "model7safe");
        }

        if (latestState) {
            printUncertaintyCalibration();
            printPredictionStats();
        }
    } catch (error) {
        console.error("update() failed:", error);
    }
}

console.log(
    `Mode=${BT_MODE} predictor=${BT_PREDICTOR} RECORD=${SHOULD_RECORD}` +
    (SHOULD_RECORD ? ` file=${RECORDING_FILE}` : "") +
    ` replay=${REPLAY_FILE}`
);

startHttpServer();
update();
setInterval(update, 5000);
if (BT_MODE === "replay") {
    setInterval(() => {
        try {
            replayTick();
        } catch (error) {
            console.error("replayTick() failed:", error);
        }
    }, 250);
}
