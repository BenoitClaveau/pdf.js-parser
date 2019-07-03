const assert = require('assert');
const Canvas = require('canvas');
const ttfInfo = require('fontinfo');
const fs = require("fs");
const path = require("path");

class NodeCanvasFactory {

    extend(context) {

        const {
            beginPath,
            moveTo,
            lineTo,
            closePath
        } = context;

        const getCoords = (x, y) => {
            const transform = context.mozCurrentTransform;
            return {
                x: transform[0] * x + transform[2] * y + transform[4],
                y: transform[1] * x + transform[3] * y + transform[5]
            };
        }

        context.beginPath = () => {
            this.store.paths = [];
            beginPath.call(context);
        }
    
        context.moveTo = (x, y) => {
            this.store.paths.push({ type: 'moveTo', ...getCoords(x, y) });
            moveTo.call(context, x, y);
        }
    
        context.lineTo = (x, y) => {
            this.store.paths.push({ type: 'lineTo', ...getCoords(x, y) });
            lineTo.call(context, x, y);
        }
    
        context.closePath = () => {
            this.store.paths.push({ type: 'close' });
            closePath.call(context);
        }

        return context;
    }
    
    constructor(store) {
        this.store = store;
    }

    create(width, height) {
        assert(width > 0 && height > 0, 'Invalid canvas size');
        var canvas = Canvas.createCanvas(width, height);
        var context = this.extend(canvas.getContext('2d'));

        return {
            canvas,
            context,
        };
    }

    reset(canvasAndContext, width, height) {
        assert(canvasAndContext.canvas, 'Canvas is not specified');
        assert(width > 0 && height > 0, 'Invalid canvas size');
        canvasAndContext.canvas.width = width;
        canvasAndContext.canvas.height = height;
    }

    destroy(canvasAndContext) {
        assert(canvasAndContext.canvas, 'Canvas is not specified');
        canvasAndContext.canvas.width = 0;
        canvasAndContext.canvas.height = 0;
        canvasAndContext.canvas = null;
        canvasAndContext.context = null;
    }
};

function registerFont(fontPath) {
    const stats = fs.statSync(fontPath);
    const files = stats.isDirectory() ? fs.readdirSync(fontPath) : [fontPath];
    for (let file of files) {
        try {
            const filepath = path.join(fontPath, file);
            const info = ttfInfo(filepath);
            Canvas.registerFont(filepath, {
                family: info.name.fontFamily,
                weight: info["OS/2"].weightClass,
                style: info.name.fontSubFamily
            });
            console.info(info.name.fontFamily)
        } catch (error) {
            //console.warn(error)
        }
    }
}

module.exports = NodeCanvasFactory;
module.exports.registerFont = registerFont;