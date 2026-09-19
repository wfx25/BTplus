"use strict";

const HORIZON_BUCKETS = [
    { min: 0, max: 10 },
    { min: 10, max: 20 },
    { min: 20, max: 30 },
    { min: 30, max: 60 }
];

function percentile(values, p) {
    if (!values || values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function mean(values) {
    if (!values || values.length === 0) {
        return null;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function errorStats(values) {
    return {
        n: values.length,
        meanGeoErrorMeters: mean(values),
        medianGeoErrorMeters: percentile(values, 50),
        p80GeoErrorMeters: percentile(values, 80),
        p95GeoErrorMeters: percentile(values, 95)
    };
}

function summarizePairs(pairs) {
    const baseline = [];
    const model1 = [];
    const model7 = [];
    const trips = new Set();
    let nModel7Fallback = 0;
    let nHold = 0;
    let nMoving = 0;

    for (const pair of pairs) {
        if (pair.gtfsTripId) {
            trips.add(`${pair.busId}|${pair.gtfsTripId}`);
        }
        if (Number.isFinite(pair.baselineErrorMeters)) {
            baseline.push(pair.baselineErrorMeters);
        }
        if (Number.isFinite(pair.model1ErrorMeters)) {
            model1.push(pair.model1ErrorMeters);
        }
        if (Number.isFinite(pair.model7ErrorMeters)) {
            model7.push(pair.model7ErrorMeters);
        }
        if (pair.model7FallbackUsed) {
            nModel7Fallback += 1;
        }
        if (pair.modelMode === "hold") {
            nHold += 1;
        } else if (pair.modelMode === "moving") {
            nMoving += 1;
        }
    }

    const model1Stats = errorStats(model1);
    const model7Stats = errorStats(model7);
    const improvement =
        model1Stats.meanGeoErrorMeters != null &&
        model7Stats.meanGeoErrorMeters != null
            ? model1Stats.meanGeoErrorMeters - model7Stats.meanGeoErrorMeters
            : null;

    return {
        completedPairCount: pairs.length,
        tripCount: trips.size,
        nHold,
        nMoving,
        nModel7Fallback,
        stalePositionBaseline: errorStats(baseline),
        model1: model1Stats,
        model7safe: model7Stats,
        improvementVsModel1: {
            meanGeoErrorMeters: improvement
        }
    };
}

function summarizeScope(pairs) {
    const summary = summarizePairs(pairs);
    return {
        completedPairCount: summary.completedPairCount,
        tripCount: summary.tripCount,
        nHold: summary.nHold,
        nMoving: summary.nMoving,
        stalePositionBaseline: summary.stalePositionBaseline,
        model1: summary.model1,
        model7safe: {
            ...summary.model7safe,
            nFallback: summary.nModel7Fallback
        },
        improvementVsModel1: summary.improvementVsModel1,
        movingOnly: (() => {
            const moving = summarizePairs(
                pairs.filter(pair => pair.modelMode === "moving")
            );
            return {
                completedPairCount: moving.completedPairCount,
                stalePositionBaseline: moving.stalePositionBaseline,
                model1: moving.model1,
                model7safe: {
                    ...moving.model7safe,
                    nFallback: moving.nModel7Fallback
                },
                improvementVsModel1: moving.improvementVsModel1
            };
        })(),
        horizonBuckets: HORIZON_BUCKETS.map(bucket => {
            const bucketPairs = pairs.filter(
                pair =>
                    pair.deltaTimeSeconds >= bucket.min &&
                    pair.deltaTimeSeconds < bucket.max
            );
            const bucketSummary = summarizePairs(bucketPairs);
            return {
                minSeconds: bucket.min,
                maxSeconds: bucket.max,
                completedPairCount: bucketSummary.completedPairCount,
                tripCount: bucketSummary.tripCount,
                nHold: bucketSummary.nHold,
                nMoving: bucketSummary.nMoving,
                stalePositionBaseline: bucketSummary.stalePositionBaseline,
                model1: bucketSummary.model1,
                model7safe: {
                    ...bucketSummary.model7safe,
                    nFallback: bucketSummary.nModel7Fallback
                },
                improvementVsModel1: bucketSummary.improvementVsModel1
            };
        })
    };
}

function buildValidationPayload({
    sessionStartMs,
    computedAtMs,
    predictorConfigured,
    pairs,
    predictorStats
}) {
    const allNetwork = summarizeScope(pairs);
    const eligiblePairs = pairs.filter(
        pair => pair.model7Eligible === true
    );
    const model7EligibleCas = summarizeScope(eligiblePairs);

    return {
        sessionStartMs,
        sessionStartUtc: sessionStartMs
            ? new Date(sessionStartMs).toISOString()
            : null,
        computedAtMs,
        computedAtUtc: new Date(computedAtMs).toISOString(),
        predictorConfigured,
        eligibility: {
            rule: "GTFS trips.route_id for the bus gtfsTripId equals CAS",
            gtfsRouteId: "CAS"
        },
        completedPairCount: allNetwork.completedPairCount,
        tripCount: allNetwork.tripCount,
        nHold: allNetwork.nHold,
        nMoving: allNetwork.nMoving,
        stalePositionBaseline: allNetwork.stalePositionBaseline,
        model1: allNetwork.model1,
        model7safe: allNetwork.model7safe,
        improvementVsModel1: allNetwork.improvementVsModel1,
        movingOnly: allNetwork.movingOnly,
        horizonBuckets: allNetwork.horizonBuckets,
        allNetwork,
        model7EligibleCas,
        fallback: predictorStats
            ? {
                countsByReason: predictorStats.fallbackCounts,
                holdCount: predictorStats.holdCount,
                appliedCount: predictorStats.appliedCount,
                historyResets: predictorStats.historyResets,
                historyResetReasons: predictorStats.historyResetReasons
            }
            : null,
        notes: {
            groundTruth:
                "A pair is counted only after a later real BT observation arrives. The unresolved latest observation is not counted. No interpolated ground truth.",
            horizonSemantics:
                "These completed-pair scores use the observed interval (current.version - previous.version) / 1000, matching offline 7A pair timing. Live serving uses wall-clock data age (NOW - observation.version) and is not the same quantity.",
            model7safe:
                "Model 7 Safe = Model 1 displacement + 0.5 * clamped HGB residual. currentSpeed <= 1 m/s on CAS-eligible trips uses exact Model 1 hold. Non-CAS trips fall back to Model 1 with reason out_of_training_scope.",
            primaryEffectiveness:
                "Use model7EligibleCas for Model 7 vs Model 1 comparison. Top-level / allNetwork stats include every completed pair for system health."
        }
    };
}

module.exports = {
    HORIZON_BUCKETS,
    percentile,
    buildValidationPayload
};
