"use strict";

const fs = require("fs");
const path = require("path");
const turf = require("@turf/turf");
const {
    getDirectedRouteProgress,
    getRoutePoint,
    getNextStopInfo,
    getUpcomingTurnInfo
} = require("./gtfs");

const RECORDING_FILE =
    process.env.BT_REPLAY_FILE ||
    "./recordings/friday-peak.jsonl";
const CALIBRATION_FRACTION = 0.7;
const HOLD_SPEED_MPS = 1;
const MIN_PRIOR_SAMPLES = 25;
const MIN_GROUP_SAMPLES = 20;

function percentile(values, p) {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function mean(values) {
    if (values.length === 0) {
        return null;
    }
    let total = 0;
    for (const value of values) {
        total += value;
    }
    return total / values.length;
}

function median(values) {
    return percentile(values, 50);
}

function metersBetween(aLat, aLon, bLat, bLon) {
    return turf.distance(
        turf.point([aLon, aLat]),
        turf.point([bLon, bLat]),
        { units: "kilometers" }
    ) * 1000;
}

function normalizeBus(raw) {
    const state = raw.states[0];
    return {
        id: raw.id,
        routeId: raw.routeId,
        patternName: raw.patternName,
        gtfsTripId: raw.gtfsTripId,
        latitude: state.latitude,
        longitude: state.longitude,
        speed: Number(state.speed),
        direction: Number(state.direction),
        version: state.version,
        isBusAtStop: state.isBusAtStop === "Y"
    };
}

function predictAlongRoute(bus, seconds, speedMps) {
    const progress = getDirectedRouteProgress(
        bus.gtfsTripId,
        bus.latitude,
        bus.longitude,
        bus.direction
    );
    if (!progress) {
        return null;
    }
    const predictedPoint = getRoutePoint(
        bus.gtfsTripId,
        progress.progressKm + (speedMps * seconds) / 1000
    );
    if (!predictedPoint) {
        return null;
    }
    return {
        latitude: predictedPoint.latitude,
        longitude: predictedPoint.longitude,
        progressKm: predictedPoint.progressKm,
        snappedProgressKm: progress.progressKm
    };
}

function predictHold(bus) {
    return {
        latitude: bus.latitude,
        longitude: bus.longitude,
        progressKm: null,
        snappedProgressKm: null,
        modelMode: "hold"
    };
}

function predictWithSpeed(bus, seconds, speedMps) {
    if (speedMps <= HOLD_SPEED_MPS) {
        return predictHold(bus);
    }
    const prediction = predictAlongRoute(bus, seconds, speedMps);
    if (!prediction) {
        return null;
    }
    return {
        ...prediction,
        modelMode: "moving"
    };
}

function productionPredict(bus, seconds) {
    return predictWithSpeed(bus, seconds, bus.speed);
}

function loadSnapshots() {
    const text = fs.readFileSync(
        path.resolve(__dirname, RECORDING_FILE),
        "utf8"
    );
    const snapshots = text
        .split("\n")
        .filter(line => line.trim() !== "")
        .map(line => JSON.parse(line));
    if (snapshots.length < 20) {
        throw new Error("Recording too short for a train/eval split");
    }
    return snapshots;
}

function bucketHorizon(seconds) {
    if (seconds < 10) return "0-10s";
    if (seconds < 20) return "10-20s";
    if (seconds < 30) return "20-30s";
    if (seconds < 60) return "30-60s";
    return "60s+";
}

function bucketSpeed(speed) {
    if (speed <= 1) return "0-1 m/s";
    if (speed <= 5) return "1-5 m/s";
    if (speed <= 10) return "5-10 m/s";
    if (speed <= 15) return "10-15 m/s";
    return "15+ m/s";
}

function bucketTurnDistance(meters) {
    if (meters == null) return "no turn in 250m";
    if (meters <= 50) return "0-50 m";
    if (meters <= 100) return "50-100 m";
    if (meters <= 250) return "100-250 m";
    return "250m+";
}

function bucketTurnAngle(degrees) {
    if (degrees == null) return "no turn in 250m";
    if (degrees < 70) return "45-70 deg";
    if (degrees < 110) return "70-110 deg";
    return "110+ deg";
}

function bucketStopDistance(meters) {
    if (meters == null) return "no upcoming stop";
    if (meters <= 50) return "0-50 m";
    if (meters <= 150) return "50-150 m";
    if (meters <= 400) return "150-400 m";
    return "400m+";
}

function summarize(errors, baselineErrors) {
    const n = errors.length;
    if (n === 0) {
        return null;
    }
    const meanErr = mean(errors);
    const baselineMean = mean(baselineErrors);
    return {
        samples: n,
        mean: meanErr,
        median: median(errors),
        p80: percentile(errors, 80),
        baselineMean,
        improvementVsBaseline:
            baselineMean == null ? null : baselineMean - meanErr
    };
}

function printGroupTable(title, groups) {
    console.log(`\n### ${title}`);
    console.log(
        "group | n | mean | median | P80 | baseline | vs baseline"
    );
    const keys = Object.keys(groups).sort();
    for (const key of keys) {
        const stats = groups[key];
        if (!stats || stats.samples < MIN_GROUP_SAMPLES) {
            continue;
        }
        console.log(
            `${key} | ${stats.samples} | ` +
            `${stats.mean.toFixed(1)} | ${stats.median.toFixed(1)} | ` +
            `${stats.p80.toFixed(1)} | ${stats.baselineMean.toFixed(1)} | ` +
            `${stats.improvementVsBaseline.toFixed(1)}`
        );
    }
}

function groupSamples(samples, keyFn) {
    const buckets = {};
    for (const sample of samples) {
        const key = keyFn(sample);
        if (!buckets[key]) {
            buckets[key] = { errors: [], baselines: [] };
        }
        buckets[key].errors.push(sample.model1Error);
        buckets[key].baselines.push(sample.baselineError);
    }
    const out = {};
    for (const [key, value] of Object.entries(buckets)) {
        out[key] = summarize(value.errors, value.baselines);
    }
    return out;
}

function collectSamples(snapshots, splitIndex) {
    const history = new Map();
    const ewma = new Map();
    const samples = [];

    for (let snapshotIndex = 0; snapshotIndex < snapshots.length; snapshotIndex++) {
        const snapshot = snapshots[snapshotIndex];
        const buses = (snapshot.data || [])
            .filter(bus => bus.states && bus.states.length > 0)
            .map(normalizeBus);
        const split = snapshotIndex < splitIndex ? "calibration" : "evaluation";

        for (const current of buses) {
            const prevList = history.get(current.id) || [];
            const previous = prevList.length > 0
                ? prevList[prevList.length - 1]
                : null;

            if (
                previous &&
                previous.gtfsTripId === current.gtfsTripId &&
                current.version > previous.version
            ) {
                const deltaTimeSeconds =
                    (current.version - previous.version) / 1000;
                if (deltaTimeSeconds > 0) {
                    const previousProgress = getDirectedRouteProgress(
                        previous.gtfsTripId,
                        previous.latitude,
                        previous.longitude,
                        previous.direction
                    );
                    const currentProgress = getDirectedRouteProgress(
                        current.gtfsTripId,
                        current.latitude,
                        current.longitude,
                        current.direction
                    );
                    const upcomingTurn = previousProgress
                        ? getUpcomingTurnInfo(
                            previous.gtfsTripId,
                            previousProgress.progressKm,
                            250
                        )
                        : null;
                    const nextStop = previousProgress
                        ? getNextStopInfo(
                            previous.gtfsTripId,
                            previousProgress.progressKm
                        )
                        : null;

                    const recentSpeeds = prevList
                        .slice(-5)
                        .map(obs => obs.speed);

                    samples.push({
                        split,
                        snapshotIndex,
                        busId: current.id,
                        routeId: previous.routeId,
                        gtfsTripId: previous.gtfsTripId,
                        previous,
                        current,
                        deltaTimeSeconds,
                        previousProgress,
                        currentProgress,
                        upcomingTurn,
                        nextStop,
                        recentSpeeds,
                        prevEwma: ewma.has(current.id)
                            ? ewma.get(current.id)
                            : previous.speed,
                        prevPrev:
                            prevList.length >= 2
                                ? prevList[prevList.length - 2]
                                : null
                    });
                }
            }

            const prevListNext = history.get(current.id) || [];
            prevListNext.push(current);
            if (prevListNext.length > 8) {
                prevListNext.shift();
            }
            history.set(current.id, prevListNext);

            const previousEwma = ewma.has(current.id)
                ? ewma.get(current.id)
                : current.speed;
            ewma.set(
                current.id,
                0.4 * current.speed + 0.6 * previousEwma
            );
        }
    }

    return samples;
}

function attachContext(sample) {
    const previous = sample.previous;
    const current = sample.current;
    const baselineError = metersBetween(
        previous.latitude,
        previous.longitude,
        current.latitude,
        current.longitude
    );

    let transitionType = "confirmed_movement";
    if (baselineError < 2) {
        transitionType = "no_observed_movement";
    } else if (baselineError < 10) {
        transitionType = "small_observed_movement";
    }

    const model1 = productionPredict(
        previous,
        sample.deltaTimeSeconds
    );
    if (!model1) {
        return null;
    }

    const model1Error = metersBetween(
        model1.latitude,
        model1.longitude,
        current.latitude,
        current.longitude
    );

    let signedProgressErrorMeters = null;
    if (
        model1.progressKm != null &&
        sample.currentProgress &&
        sample.previousProgress
    ) {
        signedProgressErrorMeters =
            (model1.progressKm - sample.currentProgress.progressKm) * 1000;
    }

    const actualAlongSpeed =
        sample.previousProgress && sample.currentProgress
            ? ((sample.currentProgress.progressKm -
                sample.previousProgress.progressKm) *
                1000) /
                sample.deltaTimeSeconds
            : null;

    return {
        ...sample,
        baselineError,
        transitionType,
        model1,
        model1Error,
        signedProgressErrorMeters,
        actualAlongSpeed,
        productionMode: model1.modelMode,
        turnDistance:
            sample.upcomingTurn
                ? sample.upcomingTurn.distanceToTurnMeters
                : null,
        turnAngle:
            sample.upcomingTurn
                ? sample.upcomingTurn.turnAngleDegrees
                : null,
        stopDistance:
            sample.nextStop
                ? sample.nextStop.distanceMeters
                : null
    };
}

function errorOf(prediction, current) {
    if (!prediction) {
        return null;
    }
    return metersBetween(
        prediction.latitude,
        prediction.longitude,
        current.latitude,
        current.longitude
    );
}

function medianOf(values) {
    return median(values);
}

function fitModel2(calibration) {
    const alphas = [0.25, 0.4, 0.6];
    const windows = [3, 5];
    let best = null;

    for (const alpha of alphas) {
        for (const window of windows) {
            const errors = [];
            for (const sample of calibration) {
                const speeds = sample.recentSpeeds.slice(-window);
                const medianSpeed = medianOf(speeds);
                const ewma =
                    alpha * sample.previous.speed +
                    (1 - alpha) * sample.prevEwma;
                const chosen = 0.5 * medianSpeed + 0.5 * ewma;
                const prediction = predictWithSpeed(
                    sample.previous,
                    sample.deltaTimeSeconds,
                    chosen
                );
                const err = errorOf(prediction, sample.current);
                if (err != null) {
                    errors.push(err);
                }
            }
            const meanErr = mean(errors);
            if (best == null || meanErr < best.mean) {
                best = { alpha, window, mean: meanErr };
            }
        }
    }
    return best;
}

function fitModel3(calibration) {
    const accelCaps = [0.4, 0.8, 1.2];
    let best = null;
    for (const cap of accelCaps) {
        const errors = [];
        for (const sample of calibration) {
            const chosen = trendingSpeed(sample, cap);
            const prediction = predictWithSpeed(
                sample.previous,
                sample.deltaTimeSeconds,
                chosen
            );
            const err = errorOf(prediction, sample.current);
            if (err != null) {
                errors.push(err);
            }
        }
        const meanErr = mean(errors);
        if (best == null || meanErr < best.mean) {
            best = { cap, mean: meanErr };
        }
    }
    return best;
}

function trendingSpeed(sample, accelCap) {
    const previous = sample.previous;
    if (!sample.prevPrev || sample.prevPrev.gtfsTripId !== previous.gtfsTripId) {
        return previous.speed;
    }
    const dt =
        (previous.version - sample.prevPrev.version) / 1000;
    if (dt <= 0) {
        return previous.speed;
    }
    const slope =
        (previous.speed - sample.prevPrev.speed) / dt;
    const boundedSlope = Math.max(-accelCap, Math.min(accelCap, slope));
    return Math.max(
        0,
        previous.speed + boundedSlope * sample.deltaTimeSeconds
    );
}

function fitTurnSlowdown(calibration) {
    const bins = {};
    for (const sample of calibration) {
        if (sample.productionMode !== "moving") {
            continue;
        }
        if (sample.actualAlongSpeed == null || sample.previous.speed < 2) {
            continue;
        }
        if (sample.turnDistance == null) {
            continue;
        }
        const key =
            `${bucketTurnDistance(sample.turnDistance)}|` +
            `${bucketTurnAngle(sample.turnAngle)}`;
        if (!bins[key]) {
            bins[key] = [];
        }
        const ratio = sample.actualAlongSpeed / sample.previous.speed;
        if (Number.isFinite(ratio) && ratio >= 0 && ratio <= 2) {
            bins[key].push(ratio);
        }
    }

    const table = {};
    for (const [key, ratios] of Object.entries(bins)) {
        if (ratios.length < MIN_PRIOR_SAMPLES) {
            continue;
        }
        const med = median(ratios);
        if (med != null && med < 0.98) {
            table[key] = med;
        }
    }
    return table;
}

function applyTurnSlowdown(sample, table) {
    if (sample.turnDistance == null) {
        return sample.previous.speed;
    }
    const key =
        `${bucketTurnDistance(sample.turnDistance)}|` +
        `${bucketTurnAngle(sample.turnAngle)}`;
    const ratio = table[key];
    if (ratio == null) {
        return sample.previous.speed;
    }
    return sample.previous.speed * ratio;
}

function fitSegmentPriors(calibration) {
    const bins = {};
    for (const sample of calibration) {
        if (
            sample.actualAlongSpeed == null ||
            !sample.previousProgress ||
            sample.deltaTimeSeconds < 3
        ) {
            continue;
        }
        if (sample.actualAlongSpeed < 0 || sample.actualAlongSpeed > 30) {
            continue;
        }
        const key =
            `${sample.routeId}:` +
            `${Math.floor(sample.previousProgress.progressKm / 0.1)}`;
        if (!bins[key]) {
            bins[key] = [];
        }
        bins[key].push(sample.actualAlongSpeed);
    }
    const table = {};
    for (const [key, speeds] of Object.entries(bins)) {
        if (speeds.length >= MIN_PRIOR_SAMPLES) {
            table[key] = median(speeds);
        }
    }
    return table;
}

function applySegmentPrior(sample, table) {
    if (!sample.previousProgress) {
        return sample.previous.speed;
    }
    const key =
        `${sample.routeId}:` +
        `${Math.floor(sample.previousProgress.progressKm / 0.1)}`;
    const prior = table[key];
    if (prior == null) {
        return sample.previous.speed;
    }
    return 0.5 * sample.previous.speed + 0.5 * prior;
}

function evaluateModel(samples, predictFn) {
    const errors = [];
    const baselines = [];
    const vsModel1 = [];
    for (const sample of samples) {
        const prediction = predictFn(sample);
        const err = errorOf(prediction, sample.current);
        if (err == null) {
            continue;
        }
        errors.push(err);
        baselines.push(sample.baselineError);
        vsModel1.push(sample.model1Error - err);
    }
    const stats = summarize(errors, baselines);
    if (!stats) {
        return null;
    }
    stats.meanVsModel1 = mean(vsModel1);
    stats.medianVsModel1 = median(vsModel1);
    return stats;
}

function printStats(name, stats, experimental) {
    if (!stats) {
        console.log(`${name}: no samples`);
        return;
    }
    const tag = experimental ? " [experimental, holdout]" : "";
    console.log(
        `${name}${tag}: n=${stats.samples} mean=${stats.mean.toFixed(1)}m ` +
        `median=${stats.median.toFixed(1)}m P80=${stats.p80.toFixed(1)}m ` +
        `vs baseline ${stats.improvementVsBaseline.toFixed(1)}m` +
        (stats.meanVsModel1 == null
            ? ""
            : ` vs Model1 ${stats.meanVsModel1.toFixed(1)}m`)
    );
}

function main() {
    console.log("BT+ offline prediction study");
    console.log("Recording:", RECORDING_FILE);
    console.log("Production predictor is unchanged.");
    console.log("Oracle is diagnostic only.\n");

    const snapshots = loadSnapshots();
    const splitIndex = Math.floor(snapshots.length * CALIBRATION_FRACTION);
    console.log(
        `Snapshots: ${snapshots.length} | calibration 0..${splitIndex - 1} | ` +
        `evaluation ${splitIndex}..${snapshots.length - 1}`
    );

    const rawSamples = collectSamples(snapshots, splitIndex)
        .map(attachContext)
        .filter(Boolean);

    const all = rawSamples;
    const calibration = rawSamples.filter(sample => sample.split === "calibration");
    const evaluation = rawSamples.filter(sample => sample.split === "evaluation");
    const movingEval = evaluation.filter(
        sample => sample.transitionType === "confirmed_movement"
    );

    console.log(
        `Valid pairs: ${all.length} (calibration ${calibration.length}, ` +
        `evaluation ${evaluation.length})`
    );

    console.log("\n========== 1. CURRENT MODEL ERROR ANALYSIS ==========");
    console.log("Descriptive on ALL valid pairs. Model 1 = current production.");
    printGroupTable(
        "Prediction horizon",
        groupSamples(all, sample => bucketHorizon(sample.deltaTimeSeconds))
    );
    printGroupTable(
        "Reported speed at prediction time",
        groupSamples(all, sample => bucketSpeed(sample.previous.speed))
    );
    printGroupTable(
        "Moving vs hold",
        groupSamples(all, sample => sample.productionMode)
    );
    printGroupTable(
        "Distance to upcoming turn",
        groupSamples(all, sample => bucketTurnDistance(sample.turnDistance))
    );
    printGroupTable(
        "Upcoming turn angle",
        groupSamples(all, sample => bucketTurnAngle(sample.turnAngle))
    );
    printGroupTable(
        "Distance to next scheduled stop",
        groupSamples(all, sample => bucketStopDistance(sample.stopDistance))
    );
    printGroupTable(
        "Route",
        groupSamples(all, sample => sample.routeId || "unknown")
    );

    const signed = all
        .map(sample => sample.signedProgressErrorMeters)
        .filter(value => value != null);
    const overshootShare =
        signed.length === 0
            ? null
            : signed.filter(value => value > 5).length / signed.length;
    const undershootShare =
        signed.length === 0
            ? null
            : signed.filter(value => value < -5).length / signed.length;

    console.log("\n### Along-route signed error (moving projections only)");
    if (signed.length === 0) {
        console.log("No along-route signed errors.");
    } else {
        console.log(
            `n=${signed.length} mean=${mean(signed).toFixed(1)}m ` +
            `(positive = overshoot past later observation)`
        );
        console.log(
            `overshoot >5m: ${(overshootShare * 100).toFixed(1)}% | ` +
            `undershoot >5m: ${(undershootShare * 100).toFixed(1)}%`
        );
    }

    const nearTurn = all.filter(
        sample => sample.turnDistance != null && sample.turnDistance <= 100
    );
    const nearStop = all.filter(
        sample => sample.stopDistance != null && sample.stopDistance <= 50
    );
    console.log(
        `\nNear turn (<=100m): n=${nearTurn.length} mean ` +
        `${mean(nearTurn.map(s => s.model1Error))?.toFixed(1)}m vs baseline ` +
        `${mean(nearTurn.map(s => s.baselineError))?.toFixed(1)}m`
    );
    console.log(
        `Near scheduled stop (<=50m): n=${nearStop.length} mean ` +
        `${mean(nearStop.map(s => s.model1Error))?.toFixed(1)}m vs baseline ` +
        `${mean(nearStop.map(s => s.baselineError))?.toFixed(1)}m`
    );

    console.log("\n========== 2. CANDIDATE MODELS (HOLDOUT) ==========");
    console.log("Parameters chosen on calibration only. Scores below are evaluation.");

    const model2Fit = fitModel2(calibration);
    const model3Fit = fitModel3(calibration);
    const turnTable = fitTurnSlowdown(calibration);
    const priorTable = fitSegmentPriors(calibration);

    console.log(
        `Model 2 tuned on calibration: alpha=${model2Fit.alpha} ` +
        `window=${model2Fit.window} calibMean=${model2Fit.mean.toFixed(1)}m`
    );
    console.log(
        `Model 3 tuned on calibration: accelCap=${model3Fit.cap} ` +
        `m/s^2 calibMean=${model3Fit.mean.toFixed(1)}m`
    );
    console.log(
        `Model 4 turn-ratio bins with slowdown: ${Object.keys(turnTable).length}`
    );
    console.log(
        `Model 5 route-segment priors: ${Object.keys(priorTable).length} bins`
    );

    const predictModel2 = sample => {
        const speeds = sample.recentSpeeds.slice(-model2Fit.window);
        const chosen =
            0.5 * medianOf(speeds) +
            0.5 * (
                model2Fit.alpha * sample.previous.speed +
                (1 - model2Fit.alpha) * sample.prevEwma
            );
        return predictWithSpeed(
            sample.previous,
            sample.deltaTimeSeconds,
            chosen
        );
    };
    const predictModel3 = sample => predictWithSpeed(
        sample.previous,
        sample.deltaTimeSeconds,
        trendingSpeed(sample, model3Fit.cap)
    );
    const predictModel4 = sample => predictWithSpeed(
        sample.previous,
        sample.deltaTimeSeconds,
        applyTurnSlowdown(sample, turnTable)
    );
    const predictModel5 = sample => predictWithSpeed(
        sample.previous,
        sample.deltaTimeSeconds,
        applySegmentPrior(sample, priorTable)
    );
    const predictOracle = sample => predictWithSpeed(
        sample.previous,
        sample.deltaTimeSeconds,
        (sample.previous.speed + sample.current.speed) / 2
    );

    const sameEval = evaluation.filter(sample => {
        return (
            predictModel2(sample) &&
            predictModel3(sample) &&
            predictModel4(sample) &&
            predictModel5(sample) &&
            productionPredict(sample.previous, sample.deltaTimeSeconds)
        );
    });
    const sameMoving = sameEval.filter(
        sample => sample.transitionType === "confirmed_movement"
    );

    console.log(`\nShared evaluation samples: ${sameEval.length}`);
    console.log(`Shared confirmed-movement samples: ${sameMoving.length}`);

    const rows = [
        ["Model 1 production", s => productionPredict(s.previous, s.deltaTimeSeconds), false],
        ["Model 2 recent-speed smooth", predictModel2, true],
        ["Model 3 bounded speed trend", predictModel3, true],
        ["Model 4 turn-ratio (data-fit)", predictModel4, true],
        ["Model 5 segment speed prior", predictModel5, true]
    ];

    console.log("\n### All shared holdout samples");
    const holdoutStats = {};
    for (const [name, fn, experimental] of rows) {
        const stats = evaluateModel(sameEval, fn);
        holdoutStats[name] = stats;
        printStats(name, stats, experimental);
    }
    printStats(
        "Speed oracle (diagnostic only, uses future speed)",
        evaluateModel(sameEval, predictOracle),
        true
    );

    console.log("\n### Confirmed-movement holdout only");
    for (const [name, fn, experimental] of rows) {
        printStats(name, evaluateModel(sameMoving, fn), experimental);
    }
    printStats(
        "Speed oracle (diagnostic only, uses future speed)",
        evaluateModel(sameMoving, predictOracle),
        true
    );

    console.log("\n========== 3. RECOMMENDATION ==========");
    const baseline = holdoutStats["Model 1 production"];
    const candidates = [
        "Model 2 recent-speed smooth",
        "Model 3 bounded speed trend",
        "Model 4 turn-ratio (data-fit)",
        "Model 5 segment speed prior"
    ];
    let winner = null;
    for (const name of candidates) {
        const stats = holdoutStats[name];
        if (!stats || !baseline) {
            continue;
        }
        const meanGain = baseline.mean - stats.mean;
        const p80Gain = baseline.p80 - stats.p80;
        const medianGain = baseline.median - stats.median;
        const robust =
            meanGain > 1 &&
            p80Gain > 0.5 &&
            medianGain > 0.5;
        console.log(
            `${name}: meanGain=${meanGain.toFixed(1)}m ` +
            `medianGain=${medianGain.toFixed(1)}m p80Gain=${p80Gain.toFixed(1)}m ` +
            `robust=${robust}`
        );
        if (robust && (winner == null || meanGain > winner.meanGain)) {
            winner = { name, meanGain };
        }
    }

    if (!winner) {
        console.log(
            "\nDo not replace the production predictor. " +
            "No candidate improved mean, median, and P80 by a robust margin on holdout."
        );
    } else {
        console.log(
            `\nCandidate with enough holdout evidence to consider next: ${winner.name}`
        );
        console.log("Still do not change production in this step.");
    }
}

main();
