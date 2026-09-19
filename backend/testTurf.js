const turf = require("@turf/turf");
function testTurf() {
    const route = turf.lineString([
        [-80.4210, 37.2280],
        [-80.4200, 37.2290],
        [-80.4190, 37.2300]
    ]);

    const busPoint = turf.point([
        -80.4204,
        37.2292
    ]);

    const snapped = turf.nearestPointOnLine(
        route,
        busPoint
    );

    console.log(snapped);
}

testTurf();