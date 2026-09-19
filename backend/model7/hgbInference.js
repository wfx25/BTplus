"use strict";

const fs = require("fs");
const path = require("path");

const MODEL_PATH = path.join(__dirname, "model7safe.json");

let cachedModel = null;

function loadModel7Safe() {
    if (cachedModel) {
        return cachedModel;
    }
    const raw = fs.readFileSync(MODEL_PATH, "utf8");
    cachedModel = JSON.parse(raw);
    return cachedModel;
}

function isMissing(value) {
    return value === null || value === undefined || Number.isNaN(value);
}

function walkTree(nodes, features) {
    let index = 0;
    for (;;) {
        const node = nodes[index];
        if (!node) {
            return null;
        }
        if (node.isLeaf) {
            return node.value;
        }
        const featureValue = features[node.featureIdx];
        let goLeft;
        if (isMissing(featureValue)) {
            goLeft = node.missingGoToLeft === true;
        } else if (featureValue <= node.numThreshold) {
            goLeft = true;
        } else {
            goLeft = false;
        }
        index = goLeft ? node.left : node.right;
    }
}

function predictRawResidual(features, model) {
    const artifact = model || loadModel7Safe();
    let prediction = artifact.baselinePrediction;
    for (const tree of artifact.trees) {
        const leafValue = walkTree(tree.nodes, features);
        if (leafValue == null || !Number.isFinite(leafValue)) {
            return null;
        }
        prediction += leafValue;
    }
    return prediction;
}

function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
}

function applySafeResidual(rawResidual, model) {
    const artifact = model || loadModel7Safe();
    const p5 = artifact.residualClamp.p5;
    const p95 = artifact.residualClamp.p95;
    const clampedResidual = clamp(rawResidual, p5, p95);
    const appliedCorrection =
        artifact.correctionScale * clampedResidual;
    return {
        rawResidual,
        clampedResidual,
        appliedCorrection,
        correctionScale: artifact.correctionScale
    };
}

function inferModel7Safe(features, model) {
    const rawResidual = predictRawResidual(features, model);
    if (rawResidual == null || !Number.isFinite(rawResidual)) {
        return null;
    }
    return applySafeResidual(rawResidual, model);
}

module.exports = {
    loadModel7Safe,
    predictRawResidual,
    applySafeResidual,
    inferModel7Safe,
    isMissing
};
