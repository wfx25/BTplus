"use strict";

process.env.BT_RECORD = "false";

const fs = require("fs");
const path = require("path");
const turf = require("@turf/turf");
const { spawnSync } = require("child_process");
const {
    createModel7Runtime
} = require("./predictor");
const { buildValidationPayload } = require("./validationStats");
const {
    getDirectedRouteProgress,
    getRouteLengthKm,
    getRoutePoint,
    isModel7EligibleTrip
} = require("../gtfs");

const REPLAY_FILE =
    process.env.BT_REPLAY_FILE ||
    path.join(__dirname, "../recordings/friday-peak.jsonl");

function geoErrorMeters(predicted, actual) {
    if (!predicted) {
        return null;
    }
    return (
        turf.distance(
            turf.point([predicted.longitude, predicted.latitude]),
            turf.point([actual.longitude, actual.latitude]),
            { units: "kilometers" }
        ) * 1000
    );
}

function loadSnapshots(filePath) {
    const text = fs.readFileSync(filePath, "utf8");
    return text
        .split("\n")
        .filter(line => line.trim() !== "")
        .map(line => JSON.parse(line));
}

function normalizeBus(raw, nowMs) {
    const state = raw.states[0];
    return {
        id: raw.id,
        routeId: raw.routeId,
        patternName: raw.patternName,
        latitude: state.latitude,
        longitude: state.longitude,
        speed: Number(state.speed),
        direction: Number(state.direction),
        gtfsTripId: raw.gtfsTripId,
        version: state.version,
        dataAge: (nowMs - state.version) / 1000,
        isBusAtStop: state.isBusAtStop === "Y"
    };
}

function main() {
    const parity = spawnSync(
        process.execPath,
        [path.join(__dirname, "testParity.js")],
        { encoding: "utf8" }
    );
    process.stdout.write(parity.stdout || "");
    process.stderr.write(parity.stderr || "");
    if (parity.status !== 0) {
        throw new Error("Fixture parity failed; stopping replay validation");
    }

    const snapshots = loadSnapshots(REPLAY_FILE);
    const runtime = createModel7Runtime();
    const store = new Map();
    const evaluated = new Map();
    const pairs = [];
    const checks = {
        versionRegression: 0,
        futureFeaturesOnEval: 0,
        holdMismatch: 0,
        wrapOutOfRange: 0,
        tripChangeResets: 0,
        uniqueObs: 0,
        casHgbApplied: 0,
        casHold: 0,
        nonCasPairs: 0,
        nonCasHgbApplied: 0,
        nonCasHgbCorrection: 0,
        nonCasScopeFallback: 0
    };
    const sessionStartMs = snapshots[0] ? snapshots[0].recordedAt : Date.now();

    function ingest(buses) {
        for (const bus of buses) {
            const histBefore = runtime.history.get(bus.id);
            if (histBefore.some(obs => obs.version > bus.version)) {
                checks.versionRegression += 1;
            }

            const old = store.get(bus.id);
            if (!old) {
                store.set(bus.id, { current: bus, previous: null });
            } else if (bus.version !== old.current.version) {
                store.set(bus.id, {
                    current: bus,
                    previous: old.current
                });
            }

            const record = store.get(bus.id);
            if (
                record.previous &&
                record.current.version === bus.version &&
                evaluated.get(bus.id) !== bus.version
            ) {
                if (record.previous.gtfsTripId !== record.current.gtfsTripId) {
                    checks.tripChangeResets += 1;
                    evaluated.set(bus.id, bus.version);
                } else {
                    const dt =
                        (record.current.version - record.previous.version) /
                        1000;
                    if (dt > 0) {
                        if (
                            histBefore.some(
                                obs =>
                                    obs.version > record.previous.version
                            )
                        ) {
                            checks.futureFeaturesOnEval += 1;
                        }
                        const model1 = requireModel1(record.previous, dt);
                        const model7 = runtime.predictSafe(
                            record.previous,
                            dt
                        );
                        if (
                            isModel7EligibleTrip(record.previous.gtfsTripId) &&
                            record.previous.speed <= 1 &&
                            model7.prediction &&
                            model1
                        ) {
                            const dLat = Math.abs(
                                model7.prediction.latitude -
                                    model1.latitude
                            );
                            const dLon = Math.abs(
                                model7.prediction.longitude -
                                    model1.longitude
                            );
                            if (dLat > 1e-12 || dLon > 1e-12) {
                                checks.holdMismatch += 1;
                            }
                        }
                        if (
                            model7.prediction &&
                            Number.isFinite(model7.prediction.progressKm)
                        ) {
                            const L = getRouteLengthKm(
                                record.previous.gtfsTripId
                            );
                            if (L > 0) {
                                const p = model7.prediction.progressKm;
                                if (p < -1e-9 || p > L + 1e-9) {
                                    checks.wrapOutOfRange += 1;
                                }
                            }
                        }
                        const eligible = isModel7EligibleTrip(
                            record.previous.gtfsTripId
                        );
                        if (model7.hgbApplied) {
                            if (eligible) {
                                checks.casHgbApplied += 1;
                            } else {
                                checks.nonCasHgbApplied += 1;
                            }
                        }
                        if (
                            eligible &&
                            model7.holdSkipHgb
                        ) {
                            checks.casHold += 1;
                        }
                        if (!eligible) {
                            checks.nonCasPairs += 1;
                            if (
                                Number.isFinite(model7.appliedCorrectionMeters) &&
                                model7.appliedCorrectionMeters !== 0
                            ) {
                                checks.nonCasHgbCorrection += 1;
                            }
                            if (
                                model7.fallbackReason ===
                                "out_of_training_scope"
                            ) {
                                checks.nonCasScopeFallback += 1;
                            }
                        }
                        pairs.push({
                            busId: record.current.id,
                            gtfsTripId: record.current.gtfsTripId,
                            deltaTimeSeconds: dt,
                            baselineErrorMeters: geoErrorMeters(
                                {
                                    latitude: record.previous.latitude,
                                    longitude: record.previous.longitude
                                },
                                record.current
                            ),
                            model1ErrorMeters: geoErrorMeters(
                                model1,
                                record.current
                            ),
                            model7ErrorMeters: geoErrorMeters(
                                model7.prediction || model1,
                                record.current
                            ),
                            model7FallbackUsed: model7.fallbackUsed,
                            model7FallbackReason: model7.fallbackReason,
                            model7Eligible: eligible,
                            model7HgbApplied: model7.hgbApplied === true,
                            model7AppliedCorrectionMeters:
                                model7.appliedCorrectionMeters,
                            modelMode:
                                record.previous.speed <= 1
                                    ? "hold"
                                    : "moving",
                            previousSpeed: record.previous.speed
                        });
                        evaluated.set(bus.id, bus.version);
                    }
                }
            }

            const recorded = runtime.recordBus(bus);
            if (recorded.recorded) {
                checks.uniqueObs += 1;
            }
        }
    }

    function requireModel1(bus, dt) {
        const directed = getDirectedRouteProgress(
            bus.gtfsTripId,
            bus.latitude,
            bus.longitude,
            bus.direction
        );
        if (bus.speed <= 1) {
            return {
                latitude: bus.latitude,
                longitude: bus.longitude,
                progressKm: directed ? directed.progressKm : null,
                modelMode: "hold"
            };
        }
        if (!directed) {
            return null;
        }
        const predicted = getRoutePoint(
            bus.gtfsTripId,
            directed.progressKm + (bus.speed * dt) / 1000
        );
        if (!predicted) {
            return null;
        }
        return {
            latitude: predicted.latitude,
            longitude: predicted.longitude,
            progressKm: predicted.progressKm,
            modelMode: "moving"
        };
    }

    for (const snapshot of snapshots) {
        const buses = (snapshot.data || [])
            .filter(bus => bus.states && bus.states.length > 0)
            .map(bus => normalizeBus(bus, snapshot.recordedAt));
        ingest(buses);
    }

    const payload = buildValidationPayload({
        sessionStartMs,
        computedAtMs: Date.now(),
        predictorConfigured: "model7safe",
        pairs,
        predictorStats: runtime.stats()
    });

    const report = {
        replayFile: REPLAY_FILE,
        snapshots: snapshots.length,
        checks,
        scope: {
            totalCompletedPairs: pairs.length,
            casEligiblePairs: pairs.filter(p => p.model7Eligible).length,
            nonCasPairs: pairs.filter(p => !p.model7Eligible).length,
            casHgbApplied: checks.casHgbApplied,
            casHold: checks.casHold,
            nonCasModel1ScopeFallbacks: checks.nonCasScopeFallback,
            nonCasHgbApplied: checks.nonCasHgbApplied,
            nonCasHgbCorrection: checks.nonCasHgbCorrection
        },
        validation: payload
    };
    console.log(JSON.stringify(report, null, 2));
}

main();
