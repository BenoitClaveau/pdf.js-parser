const { CanvasGraphics, OPS } = require("./dist/pdf");
const { createBox } = require('./box');

/**
 * Je surchage la factory ajoutée (// PATCH) dans pdf.js
 * pour utiliser un nouveau canvas PDFCanvasGraphics
 */
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
        this.process();
        super.stroke();
    }

    [OPS.stroke]() {
        this.process();
        super.stroke();
    }

    fill() {
        this.process();
        super.fill();
    }

    [OPS.fill]() {
        this.process();
        super.fill();
    }
    
    process() {
        const { paths } = this.store;
        for (let [i, path] of paths.entries()) {
            switch (path.type) {
                case 'lineTo':
                    if (i > 0) this.drawLine(paths[i - 1], path);
                    break;
                case 'close':
                    if (i > 0) this.drawLine(paths[i - 1], paths[0]);
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