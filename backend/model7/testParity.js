"use strict";

const fs = require("fs");
const path = require("path");
const {
    loadModel7Safe,
    inferModel7Safe
} = require("./hgbInference");

function toFeatureVector(values) {
    return values.map(value => (value === null ? NaN : value));
}

function main() {
    const fixturesPath = path.join(__dirname, "model7safe-parity-fixtures.json");
    const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
    const model = loadModel7Safe();
    const diffs = {
        raw: [],
        clamped: [],
        safe: []
    };
    let worst = null;

    for (const fixture of fixtures.cases) {
        const result = inferModel7Safe(
            toFeatureVector(fixture.features),
            model
        );
        if (!result) {
            throw new Error(`Inference failed for ${fixture.passLabel}`);
        }
        const rawDiff = Math.abs(
            result.rawResidual - fixture.expectedRawHgbResidual
        );
        const clampedDiff = Math.abs(
            result.clampedResidual - fixture.expectedClampedResidual
        );
        const safeDiff = Math.abs(
            result.appliedCorrection - fixture.expectedSafeResidual
        );
        diffs.raw.push(rawDiff);
        diffs.clamped.push(clampedDiff);
        diffs.safe.push(safeDiff);
        const maxLocal = Math.max(rawDiff, clampedDiff, safeDiff);
        if (!worst || maxLocal > worst.maxAbs) {
            worst = {
                passLabel: fixture.passLabel,
                previousVersion: fixture.previousVersion,
                maxAbs: maxLocal,
                rawDiff,
                clampedDiff,
                safeDiff
            };
        }
    }

    function summarize(values) {
        const mean =
            values.reduce((sum, value) => sum + value, 0) / values.length;
        return {
            n: values.length,
            meanAbs: mean,
            maxAbs: Math.max(...values)
        };
    }

    const report = {
        n: fixtures.cases.length,
        raw: summarize(diffs.raw),
        clamped: summarize(diffs.clamped),
        safe: summarize(diffs.safe),
        worst
    };

    console.log(JSON.stringify(report, null, 2));

    const maxAbs = Math.max(
        report.raw.maxAbs,
        report.clamped.maxAbs,
        report.safe.maxAbs
    );
    if (maxAbs > 1e-9) {
        console.error("PARITY FAILED");
        process.exit(1);
    }
    console.log("PARITY OK");
}

main();
