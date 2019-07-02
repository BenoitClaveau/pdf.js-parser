const PDFJS = require('./dist/pdf');
const NodeCanvasFactory = require('./node-canvas-factory');
const CanvasGraphicsFactory = require('./canvas-graphics-factory');

PDFJS.disableWorker = true;

class PDFParser {
    /**
     * 
     * @param {*} page const page = await document.getPage(1);
     */
    static async render(page) {
        const store = {
            paths: [],
            lines: [],
            texts: []
        };
        const canvasFactory = new NodeCanvasFactory(store);
        const canvasGraphicsFactory = new CanvasGraphicsFactory(store);

        const viewport = page.getViewport({ scale: 1.0 });
        if (Number.isNaN(viewport.width)) viewport.width = viewport.viewBox[2];
        if (Number.isNaN(viewport.height)) viewport.height = viewport.viewBox[3];

        const { context: canvasContext } = canvasFactory.create(viewport.width, viewport.height);

        await page.render({
            canvasContext,
            viewport,
            canvasFactory,
            canvasGraphicsFactory
        });

        const textContent = await page.getTextContent({ normalizeWhitespace: true });

        for (let textItem of textContent.items) {
            var tx = PDFJS.Util.transform(
                PDFJS.Util.transform(viewport.transform, textItem.transform),
                [1, 0, 0, -1, 0, 0]
            );

            var style = textContent.styles[textItem.fontName];

            // adjust for font ascent/descent
            var fontSize = Math.sqrt((tx[2] * tx[2]) + (tx[3] * tx[3]));

            if (style.ascent) {
                tx[5] -= fontSize * style.ascent;
            } else if (style.descent) {
                tx[5] -= fontSize * (1 + style.descent);
            } else {
                tx[5] -= fontSize / 2;
            }

            // adjust for rendered width
            if (textItem.width > 0) {
                canvasContext.font = tx[0] + 'px ' + style.fontFamily;

                var width = canvasContext.measureText(textItem.str).width;

                if (width > 0) {
                    tx[0] = (textItem.width * viewport.scale) / width;
                }
            }

            store.texts.push({
                ...createBox({
                    x: tx[4],
                    y: tx[5],
                    w: textItem.width,
                    h: textItem.height
                }),
                text: textItem.str
            });
        }

        return {
            context: canvasContext,
            ...store
        }
    }
}


module.exports = PDFJS;
module.exports.parse = PDFParser.parse;