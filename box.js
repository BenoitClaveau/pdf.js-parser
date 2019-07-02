const centroid = (e) => {
    return {
        x: e.x + (0.5 * e.w),
        y: e.y + (0.5 * e.h)
    };
}

const createBox = (e) => {
    return {
        ...e,
        centroid: centroid(e)
    }
}

module.exports.centroid = centroid;
module.exports.createBox = createBox;