"use strict";

const { getRoutePoint, isModel7EligibleTrip } = require("../gtfs");
const {
    loadModel7Safe,
    inferModel7Safe
} = require("./hgbInference");
const {
    ObservationHistory,
    buildEnrichedObservation,
    buildFeatureVector,
    previousUniqueFromHistory
} = require("./features");

const HOLD_MAX_SPEED_MPS = 1;
const CORRECTION_SCALE = 0.5;

let modelLoadError = null;
let model = null;
try {
    model = loadModel7Safe();
} catch (error) {
    modelLoadError = error;
    model = null;
}

function model7RuntimeAvailable() {
    return model != null && modelLoadError == null;
}

function createModel7Runtime() {
    const history = new ObservationHistory();
    const fallbackCounts = {};
    let holdCount = 0;
    let appliedCount = 0;

    function bumpFallback(reason) {
        fallbackCounts[reason] = (fallbackCounts[reason] || 0) + 1;
    }

    function recordBus(bus) {
        const enriched = buildEnrichedObservation(bus);
        if (!enriched) {
            if (bus && bus.id) {
                history.reset(bus.id, "invalid_route_match");
            }
            return { recorded: false, reason: "invalid_route_match" };
        }
        return history.record(enriched);
    }

    function predictSafe(bus, horizonSeconds, options) {
        const trackStats = !options || options.trackStats !== false;
        const model1MovingDisplacementMeters =
            bus.speed * horizonSeconds;

        function fallback(reason, model1Prediction) {
            if (trackStats) {
                bumpFallback(reason);
            }
            return {
                ok: false,
                fallbackUsed: true,
                fallbackReason: reason,
                holdSkipHgb: false,
                hgbApplied: false,
                model1DisplacementMeters: model1MovingDisplacementMeters,
                rawMlResidualMeters: null,
                clampedMlResidualMeters: null,
                appliedCorrectionMeters: 0,
                correctionScale: CORRECTION_SCALE,
                features: null,
                prediction: model1Prediction,
                startProgressKm: model1Prediction
                    ? model1Prediction.snappedProgressKm
                    : null
            };
        }

        if (!model7RuntimeAvailable()) {
            return fallback("model_artifact_load_failure", null);
        }

        if (!bus || !bus.gtfsTripId) {
            return fallback("invalid_trip", null);
        }

        if (!isModel7EligibleTrip(bus.gtfsTripId)) {
            return fallback("out_of_training_scope", null);
        }

        const enriched = buildEnrichedObservation(bus);
        if (!enriched) {
            return fallback("invalid_route_match", null);
        }

        if (bus.speed <= HOLD_MAX_SPEED_MPS) {
            if (trackStats) {
                holdCount += 1;
            }
            return {
                ok: true,
                fallbackUsed: false,
                fallbackReason: null,
                holdSkipHgb: true,
                hgbApplied: false,
                model1DisplacementMeters: 0,
                rawMlResidualMeters: null,
                clampedMlResidualMeters: null,
                appliedCorrectionMeters: 0,
                correctionScale: CORRECTION_SCALE,
                features: null,
                prediction: {
                    latitude: bus.latitude,
                    longitude: bus.longitude,
                    progressKm: null,
                    snappedProgressKm: enriched.progressKm,
                    snappedDistanceMeters: 0,
                    segmentIndex: null,
                    headingDifference: null,
                    modelMode: "hold"
                },
                startProgressKm: enriched.progressKm
            };
        }

        const allHist = history.get(bus.id);
        if (allHist.some(obs => obs.version > bus.version)) {
            return fallback("future_observation_in_history", null);
        }
        const hist = allHist.filter(
            obs => obs.version <= bus.version
        );
        const currentInHistory = hist.find(
            obs => obs.version === bus.version
        );
        const current = currentInHistory || enriched;

        const previousUnique = previousUniqueFromHistory(
            currentInHistory ? hist : hist.concat([current]),
            current
        );

        let featureResult;
        try {
            featureResult = buildFeatureVector(
                current,
                previousUnique,
                horizonSeconds
            );
        } catch (error) {
            return fallback("feature_construction_failure", null);
        }

        if (!featureResult.ok) {
            return fallback(featureResult.reason, null);
        }

        const inferred = inferModel7Safe(featureResult.values, model);
        if (
            !inferred ||
            !Number.isFinite(inferred.rawResidual) ||
            !Number.isFinite(inferred.clampedResidual) ||
            !Number.isFinite(inferred.appliedCorrection)
        ) {
            return fallback("non_finite_model_result", null);
        }

        const model7DisplacementMeters =
            model1MovingDisplacementMeters + inferred.appliedCorrection;
        if (!Number.isFinite(model7DisplacementMeters)) {
            return fallback("non_finite_model_result", null);
        }

        const predictedProgressKm =
            current.progressKm + model7DisplacementMeters / 1000;
        const predictedPoint = getRoutePoint(
            bus.gtfsTripId,
            predictedProgressKm
        );
        if (!predictedPoint) {
            return fallback("route_point_unavailable", null);
        }

        if (trackStats) {
            appliedCount += 1;
        }
        return {
            ok: true,
            fallbackUsed: false,
            fallbackReason: null,
            holdSkipHgb: false,
            hgbApplied: true,
            model1DisplacementMeters: model1MovingDisplacementMeters,
            rawMlResidualMeters: inferred.rawResidual,
            clampedMlResidualMeters: inferred.clampedResidual,
            appliedCorrectionMeters: inferred.appliedCorrection,
            correctionScale: CORRECTION_SCALE,
            features: featureResult.values,
            prediction: {
                latitude: predictedPoint.latitude,
                longitude: predictedPoint.longitude,
                progressKm: predictedPoint.progressKm,
                snappedProgressKm: current.progressKm,
                snappedDistanceMeters: 0,
                segmentIndex: null,
                headingDifference: null,
                modelMode: "moving"
            },
            startProgressKm:
                current.progressKm + inferred.appliedCorrection / 1000
        };
    }

    return {
        history,
        recordBus,
        predictSafe,
        resetAll() {
            history.resetAll();
        },
        stats() {
            return {
                fallbackCounts: { ...fallbackCounts },
                holdCount,
                appliedCount,
                historyResets: history.resetCount,
                historyResetReasons: { ...history.resetReasons }
            };
        }
    };
}

module.exports = {
    HOLD_MAX_SPEED_MPS,
    CORRECTION_SCALE,
    model7RuntimeAvailable,
    createModel7Runtime
};
