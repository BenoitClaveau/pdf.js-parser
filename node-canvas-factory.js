const assert = require('assert');
const Canvas = require('canvas');

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
    
        moveTo(x, y) = () => {
            this.store.paths.push({ type: 'moveTo', ...getCoords(x, y) });
            moveTo.call(context, x, y);
        }
    
        lineTo(x, y) = () => {
            this.store.paths.push({ type: 'lineTo', ...getCoords(x, y) });
            lineTo.call(context, x, y);
        }
    
        closePath() = () => {
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

exports = module.exports = NodeCanvasFactory;