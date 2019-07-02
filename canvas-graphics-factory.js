const { CanvasGraphics, OPS } = require("./dist/pdf");
const { createBox } = require('./box');

class CanvasGraphicsFactory {
  
    constructor(store) {
        this.store = store;
    }

    create(canvasCtx, commonObjs, objs, canvasFactory, webGLContext, imageLayer) {
      return new PDFCanvasGraphics(this.store, canvasCtx, commonObjs, objs, canvasFactory, webGLContext, imageLayer);
    }
    
}

class PDFCanvasGraphics extends CanvasGraphics {
    constructor(store, canvasCtx, commonObjs, objs, canvasFactory, webGLContext, imageLayer) {
        super(canvasCtx, commonObjs, objs, canvasFactory, webGLContext, imageLayer);
        this.store = store;
    }

    stroke() {
        processPaths();
        super.stroke();
    }

    [OPS.stroke] {
        processPaths();
        super.stroke();
    }

    processPaths() {
        for (let [i, path] of this.store.paths.entries()) {
            switch (path.type) {
                case 'lineTo':
                    if (i > 0) this.drawLine(this.paths[i - 1], path);
                    break;
                case 'close':
                    if (i > 0) this.drawLine(this.paths[i - 1], this.paths[0]);
                    break;
                case 'moveTo': break;
                case 'bezierCurveTo':
                case 'at':
                case 'wa':
                    break;
            }
        }
    }

    drawLine (p1, p2) {
        const x = Math.min(p1.x, p2.x);
        const y = Math.min(p1.y, p2.y);
        const w = Math.max(1, Math.max(p1.x, p2.x) - x);
        const h = Math.max(1, Math.max(p1.y, p2.y) - y);
        this.store.lines.push(createBox({ x, y, w, h }));
    }

}


exports = module.exports = CanvasGraphicsFactory;