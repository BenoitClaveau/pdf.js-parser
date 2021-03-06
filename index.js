// HACK few hacks to let PDF.js be loaded not as a module in global space.
// https://github.com/mozilla/pdf.js/blob/master/examples/node/pdf2svg.js
require("./domstubs.js").setStubs(global);

const { promisify, inspect } = require("util");
const util = require("util");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { pipeline } = require("stream");
const stream = require("stream");
const { exec } = require('child_process');
const { randomBytes } = require('crypto');
const NodeCanvasFactory = require('./node-canvas-factory');
const CanvasGraphicsFactory = require('./canvas-graphics-factory');
const { createBox, centroid } = require('./box');
const Rect = require("./rect");
const pipelineAsync = promisify(pipeline);
const execAsync = promisify(exec);
const randomName = () => randomBytes(4).readUInt32LE(0);

const PDFJS = require('./dist/pdf');
PDFJS.GlobalWorkerOptions.disableWorker = true;
PDFJS.GlobalWorkerOptions.workerSrc = undefined;
//PDFJS.GlobalWorkerOptions.workerSrc = require("./dist/pdf.worker");

// Some PDFs need external cmaps.
const CMAP_URL = path.join(__dirname, "cmaps");
const CMAP_PACKED = true;

NodeCanvasFactory.registerFont(path.join(__dirname, "fonts"));

class PDFParser {

    static async read(data) {
        const document = await PDFJS.getDocument({
            data,
            //disableFontFace: false,
            cMapUrl: CMAP_URL,
            cMapPacked: CMAP_PACKED,
            fontExtraProperties: true,
            verbosity: PDFJS.VerbosityLevel.Error,
        }).promise;

        return document;
    }
    /**
     *
     * @param {*} page const page = await document.getPage(1);
     */
    static async render(page) {
        const store = {
            paths: [],
            lines: [],
            vlines: [],
            hlines: [],
            texts: []
        };
        const canvasFactory = new NodeCanvasFactory(store);
        const canvasGraphicsFactory = new CanvasGraphicsFactory(store);

        const viewport = page.getViewport({ scale: 1.0 });
        if (Number.isNaN(viewport.width)) viewport.width = viewport.viewBox[2];
        if (Number.isNaN(viewport.height)) viewport.height = viewport.viewBox[3];

        const {
            context,
            canvas
        } = canvasFactory.create(viewport.width, viewport.height);

        await page.render({
            canvasContext: context,
            viewport,
            canvasFactory,
            canvasGraphicsFactory
        }).promise;

        return {
            canvas,
            context,
            viewport,
            store,
        }
    }

    static async renderAsSVG(page) {
        const store = {
        };

        const viewport = page.getViewport({ scale: 1.0 });
        const opList = await page.getOperatorList();
        const svgGfx = new PDFJS.SVGGraphics(page.commonObjs, page.objs);
        svgGfx.embedFonts = true;
        const svg = await svgGfx.getSVG(opList, viewport);

        return {
            svg,
            viewport,
            store
        }
    }

    static async parse(page) {
        const res = await PDFParser.render(page);
        const data = { ...res, page };

        await PDFParser._extractTexts(data);
        await PDFParser._extractLines(data);
        await PDFParser._generateBoxes(data);
        await PDFParser._mergeTexts(data);

        await PDFParser._extractAnnotations(data);

        return {
            canvas: res.canvas,
            context: res.context,
            viewport: res.viewport,
            page: Object.assign(page, { pageIndex: page._pageIndex }), // Cause by change in pdf.js pageIndex was rename _pageIndex
            hlines: res.store.hlines,
            vlines: res.store.vlines,
            boxes: res.store.boxes,
            texts: res.store.texts,
        };
    }

    static async _extractTexts(data) {
        const { context, canvas, viewport, store, page } = data;

        const textContent = await page.getTextContent({ normalizeWhitespace: true });

        for (const textItem of textContent.items) {

            const tx = PDFJS.Util.transform(
                PDFJS.Util.transform(viewport.transform, textItem.transform),
                [1, 0, 0, -1, 0, 0]
            );

            const style = textContent.styles[textItem.fontName];
            const fontFamily = style.fontFamily;

            // adjust for font ascent/descent
            const fontSize = Math.sqrt((tx[2] * tx[2]) + (tx[3] * tx[3]));

            if (style.ascent)
                tx[5] -= fontSize * style.ascent;

            if (style.descent)
                tx[5] -= fontSize * style.descent;

            // context.font = tx[0] + 'px ' + style.fontFamily;
            // const { width: sw } = context.measureText(" ");

            // measureText crash de façon aleatoire.
            // je le remplace par un calcul de sw faux mais qui s'approche du résultat
            // il faudra le modifier;
            let sw = 0.2 * fontSize;
            let font = undefined;
            let fontName = undefined;
            try {
                font = page.commonObjs._objs[textItem.fontName];
                if (font && font.data) {
                    if (font.data.widths) {
                        let spaceWidth = font.data.widths[32]; // largeur de l'espace // sinon prendre la premiète lettre;
                        if (spaceWidth == undefined) {
                            // je recherche le premier caractère
                            spaceWidth = font.data.widths.find((e, i) => i >= 48 && i < 90 && e > 0);
                        }
                        sw = Math.round((fontSize * spaceWidth) / viewport.width);
                    }
                    const fonts = font.data.name.split("+");
                    if (fonts.length == 2)
                        fontName = fonts[1];
                }

            }
            catch (error) {
                console.error(inspect(error));
            }

            const item = {
                ...createBox({
                    x: tx[4],
                    y: tx[5],
                    w: textItem.width,
                    h: textItem.height
                }),
                text: textItem.str,
                sw,
                fontFamily,
                fontSize,
                font,
                fontName
            }
            if (store.texts.some(e => e.text == item.text && e.x == item.x && e.y == item.y)) continue;
            store.texts.push(item);
        }

        store.texts.sort(PDFParser.compareBlockPos);

    }

    /**
     * Des champs de saisies peuvent contenir du texte.
     */
    static async _extractAnnotations(data) {
        const { context, canvas, viewport, store, page } = data;

        const annotations = await page.getAnnotations();

        for (const annotation of annotations) {
            const text = Array.isArray(annotation.fieldValue) ? 
                            annotation.fieldValue.join(" ").trim() : 
                            annotation.fieldValue?.trim();
            if (!text) continue;
            const bbox = viewport.convertToViewportRectangle(annotation.rect);
            const item = {
                ...createBox({
                    x: bbox[0],
                    y: bbox[3],
                    w: bbox[2] - bbox[0],
                    h: bbox[1] - bbox[3]
                }),
                text,
                // fontFamily,
                // fontSize,
                // font,
                // fontName
            }

            if (store.texts.some(e => e.text == item.text && e.x == item.x && e.y == item.y)) continue;
            store.texts.push(item);
        }
    }

    static _mergeTexts(data) {
        const { store } = data;
        let adjacents = 1;
        while (adjacents > 0) {
            adjacents = 0;
            for (let i = 0; i < store.texts.length; i++) {
                const text = store.texts[i];
                if (text.merged) continue;
                const childrenAdjacent = store.texts.filter((t, j) => {
                    return text != t && PDFParser.areAdjacentBlocksOnX(text, t, text.sw * 0.85);
                }).sort((a, b) => a.x - b.x); // important, je retrie pour supprimer le tri par Y et ne prendre en compte que le x.

                for (let child of childrenAdjacent) {
                    // je recherche des ligne entre les 2 blocks.
                    const x = text.centroid.x;
                    const y = Math.min(text.y, child.y);
                    const w = child.centroid.x - x;
                    const h = Math.min(text.y + text.h, child.y + child.h) - y;

                    const b = store.boxes.filter(e => Rect.collideRectRect(e.x, e.y, e.w, e.h, x, y, w, h));
                    if (b.length) break; // j'ai trouvé des lignes, je préfère ne pas merger.
                    text.text += child.text;
                    text.w = child.x + child.w - text.x;
                    const bottom = Math.max(text.y + text.h, child.y + child.h);
                    text.y = Math.min(text.y, child.y);
                    text.h = bottom - text.y;
                    text.centroid = centroid(text);
                    child.merged = true;
                    adjacents++;
                }
            }
            store.texts = store.texts.filter(e => !e.merged);
        }

        store.texts.sort(PDFParser.compareBlockPos);

    }

    static _extractLines(data) {
        const { store, viewport } = data;

        const screen = createBox({
            x: 0,
            y: 0,
            w: viewport.width,
            h: viewport.height
        });

        const bigs = store.lines.filter(e => e.w > 10 && e.h > 10);
        const smalls = store.lines.filter(e => bigs.indexOf(e) == -1);

        if (smalls.length > 1000) return; // le nombre de lignes est trop important. Le traitement sera trop long. Je préfère quitter.

        const smallsH = smalls.filter(e => e.w >= e.h);
        const smallsV = smalls.filter(e => e.w < e.h);

        for (let i = 0; i < smallsH.length; i++) {
            const box = smallsH[i];
            const box2 = smallsH.filter(e => box != e && Rect.collideRectRect(e.x - 5, e.y - 5, e.w + 10, e.h + 10, box.x, box.y, box.w, box.h)).shift();
            if (!box2) continue;
            smallsH[i] = createBox(Rect.unionRect(box.x, box.y, box.w, box.h, box2.x, box2.y, box2.w, box2.h));
            smallsH.splice(smallsH.indexOf(box2), 1);
            i--;
        }

        //fusionner à l'horizontal les petits rectangles
        for (let i = 0; i < smallsV.length; i++) {
            const box = smallsV[i];
            const box2 = smallsV.filter(e => box != e && Rect.collideRectRect(e.x - 5, e.y - 5, e.w + 10, e.h + 10, box.x, box.y, box.w, box.h)).shift();
            if (!box2) continue;
            smallsV[i] = createBox(Rect.unionRect(box.x, box.y, box.w, box.h, box2.x, box2.y, box2.w, box2.h));
            smallsV.splice(smallsV.indexOf(box2), 1);
            i--;
        }

        const rects = [screen, ...bigs, ...smallsH, ...smallsV].sort(PDFParser.compareBlockPos);

        const lines = rects.reduce((p, rect) => {
            const left = createBox({ ...rect, w: 1 });
            const top = createBox({ ...rect, h: 1 });
            const right = createBox({ ...rect, x: rect.x + rect.w, w: 1 });
            const bottom = createBox({ ...rect, y: rect.y + rect.h, h: 1 });

            if (!p.some(e => Rect.equalsRectObj(e, left, 1))) p.push(left);
            if (!p.some(e => Rect.equalsRectObj(e, top, 1))) p.push(top);
            if (!p.some(e => Rect.equalsRectObj(e, right, 1))) p.push(right);
            if (!p.some(e => Rect.equalsRectObj(e, bottom, 1))) p.push(bottom);

            return p;
        }, []).sort(PDFParser.compareBlockPos);

        const hLines = lines.filter(e => e.w > e.h && e.h <= 1).reduce((p, c) => {
            if (!p.some(e => Rect.equalsRectObj(e, c, 1))) p.push(c);
            return p;
        }, []).sort(PDFParser.compareBlockPos);

        const vLines = lines.filter(e => e.h > e.w && e.w <= 1).reduce((p, c) => {
            if (!p.some(e => Rect.equalsRectObj(e, c, 1))) p.push(c);
            return p;
        }, []).sort(PDFParser.compareBlockPos);

        // je merge les lignes
        for (let i = 0; i < hLines.length; i++) {
            const line = hLines[i];
            const line2 = hLines.filter(e => line != e && Rect.collideRectRect(e.x - 5, e.y - 5, e.w + 10, e.h + 10, line.x, line.y, line.w, line.h)).shift();
            if (!line2) continue;
            hLines[i] = createBox({ ...Rect.unionRect(line.x, line.y, line.w, line.h, line2.x, line2.y, line2.w, line2.h), h: 1 });
            hLines.splice(hLines.indexOf(line2), 1);
            i--;
        }

        for (let i = 0; i < vLines.length; i++) {
            const line = vLines[i]
            const line2 = vLines.filter(e => line != e && Rect.collideRectRect(e.x - 5, e.y - 5, e.w + 10, e.h + 10, line.x, line.y, line.w, line.h)).shift();
            if (!line2) continue;
            vLines[i] = createBox({ ...Rect.unionRect(line.x, line.y, line.w, line.h, line2.x, line2.y, line2.w, line2.h), w: 1 });
            vLines.splice(vLines.indexOf(line2), 1);
            i--;
        }

        store.hlines = hLines.reduce((p, c) => {
            if (!p.some(e => Rect.equalsRectObj(e, c, 1))) p.push(c);
            return p;
        }, []).sort(PDFParser.compareBlockPos);

        store.vlines = vLines.reduce((p, c) => {
            if (!p.some(e => Rect.equalsRectObj(e, c, 1))) p.push(c);
            return p;
        }, []).sort(PDFParser.compareBlockPos);

    }

    static _generateBoxes(data) {
        const { viewport, store } = data;

        const newHBorders = [];
        for (let [k, box] of store.vlines.entries()) {

            let vlines = store.vlines.filter(e => Rect.collideRectRect(e.x, e.y, e.w, e.h, 0, box.y - 5, viewport.width, 10));
            vlines = vlines.filter(e => Math.abs(box.h - e.h) < 10).sort((a, b) => a.x - b.x);

            if (vlines.length > 1) {
                const x = Math.min(...vlines.map(e => e.x));
                const y = Math.min(...vlines.map(e => e.y));
                const w = Math.max(...vlines.map(e => e.x + e.w)) - x;
                const h = Math.max(...vlines.map(e => e.y + e.h)) - y;
                const area = { x, y, w, h };
                const top = createBox({ ...area, h: 1 });
                const bottom = createBox({ ...area, y: area.y + area.h, h: 1 });
                if (!newHBorders.some(e => Rect.equalsRectObj(e, top)))
                    newHBorders.push(top);
                if (!newHBorders.some(e => Rect.equalsRectObj(e, bottom)))
                    newHBorders.push(bottom);

                // je mets à jours les lignes
                for (let vline of vlines)
                    Object.assign(vline, { y: area.y, h: area.h });
            }
        }

        store.hlines = [...store.hlines, ...newHBorders].sort(PDFParser.compareBlockPos);

        const hBorders = [];
        for (let box of store.hlines) {
            // collisions avec des lignes verticales.
            hBorders.push(PDFParser._horizontalCollides(data, box));
        }

        let boxes = [];
        for (let [k, topBorder] of hBorders.entries()) {
            const bottomsBorders = hBorders.filter(e => e.box.centroid.y > topBorder.box.centroid.y && Rect.collideRectRect(e.box.x, topBorder.box.y, e.box.w, e.box.h, topBorder.box.x, topBorder.box.y, topBorder.box.w, topBorder.box.h));

            // j'essaye toutes les possibiltés left et right pour trouver toutes les boites
            for (let begin = 0; begin < topBorder.collides.length - 1; begin++) {
                for (let end = begin + 1; end < topBorder.collides.length; end++) {
                    const left = topBorder.collides[begin];
                    const right = topBorder.collides[end];

                    for (let j = 0; j < bottomsBorders.length; j++) {
                        const bottomBorder = bottomsBorders[j];
                        const leftIndex = bottomBorder.collides.indexOf(left);
                        if (leftIndex == -1) continue;
                        const rightIndex = bottomBorder.collides.indexOf(right);
                        if (rightIndex == -1) continue;

                        // je recupère les collisions entre left et right
                        const inters = bottomBorder.collides.slice(leftIndex + 1, rightIndex);
                        // Si topBorder au une collision avec une de limite alors une boite (plus petite) sera créée. Il ne faut pas la créer car elle serait trop grande.
                        const hasInter = inters.some(e => topBorder.collides.some(f => e == f));
                        if (hasInter)
                            continue;

                        const b = createBox({
                            y: topBorder.box.centroid.y,
                            h: bottomBorder.box.y - topBorder.box.y,    // je ne prend pas centroid pour être insensible à box.h
                            x: left.centroid.x,
                            w: right.x - left.x                         // je ne prend pas centroid pour être insensible à left.w
                        })
                        boxes.push(b);
                        break; // je quitte car une boite avec left a été trouvé. C'est la plus petite ! Je ne veux pas trouver de plus grande
                    }
                }
            }
        }

        // je calcule l'air
        boxes = boxes.map(e => Object.assign(e, { area: Rect.areaRect(e.w, e.h) })).sort((a, b) => a.area - b.area);
        for (let box of boxes) {
            const texts = store.texts.filter(e => Rect.collidePointRect(e.centroid.x, e.centroid.y, box.x, box.y, box.w, box.h));
            if (!texts.length) {
                box.ignore = true;                // j'ignore les boites vides;
                continue;
            }
            if (box.h < 5 || box.w < 5) {
                box.ignore = true;      // j'ignore les boites trop petites
                continue;
            }

            const boxes2 = boxes.filter(e => e != box && !e.ignore);

            //if (Rect.equalsRectObj(box, { x: 0, y: 0, w: viewport.width, h: viewport.height }, 1)) box.ignore = true;  // j'ignore les cadres
            if (boxes2.some(e => Rect.equalsRectObj(e, box, 5))) {
                box.ignore = true; // j'ignore les boites trop proche
                continue;
            }

            // Box est-t-elle un cadre ?
            const children = boxes2.filter(e => Rect.insideRectRect(e.x, e.y, e.w, e.h, box.x, box.y, box.w, box.h)).sort(PDFParser.compareBlockPos);
            if (children.length == 1) {
                children[0].ignore = true; // je garde la boite la plus grande
                continue;
            }

            if (children.length > 1) { // plusieurs enfants. Je calcule la somme des ecarts (vide). S'elle est petite j'ignore la boite. Je la consid�re comme un cadre.
                const ecarts = ecart(children.map(e => [e.y, e.y + e.h])).filter(e => e > 0);
                const total = ecarts.reduce((sum, x) => sum + x, 0);
                if (total < box.h * 0.3) {
                    box.ignore = true;
                    continue;
                }
            }
        }

        store.boxes = boxes.filter(e => !e.ignore);

        store.boxes.sort(PDFParser.compareBlockPos);
    }

    static _horizontalCollides(data, hline) {
        const { store } = data;
        const collides = store.vlines.filter(e => Rect.collideRectRect(e.x - 1, e.y - 1, e.w + 1, e.h + 1, hline.x - 1, hline.y - 1, hline.w + 1, hline.h + 1));
        // cr�ation de lignes verticales virtuelles pour "fermer" les boites.
        const left = collides.length ? collides[0] : null
        const right = collides.length ? collides[collides.length - 1] : null;
        if (left && hline.x < left.x - 1) {
            // box d�passe left, je vais dupliquer left sur la gauche pour cr�er une ligne verticale.
            const left2 = createBox({ ...left, x: hline.x });
            collides.splice(0, 0, left2);
            store.vlines = [...store.vlines, left2].sort(PDFParser.compareBlockPos);
        }
        if (right && hline.x + hline.w > right.x + right.w + 1) {
            // box dépasse right, je vais dupliquer right sur la droite pour cr�er une ligne verticale.
            const right2 = createBox({ ...left, x: hline.x + hline.w });
            collides.splice(-1, 0, right2);
            store.vlines = [...store.vlines, right2].sort(PDFParser.compareBlockPos);
        }
        return {
            box: hline,
            collides: collides.sort((a, b) => a.x - b.x)
        };
    }

    static compareBlockPos(t1, t2) {
        const DISTANCE_DELTA = 5;

        if (t1.y < t2.y - DISTANCE_DELTA) {
            return -1;
        }
        if (Math.abs(t1.y - t2.y) <= DISTANCE_DELTA) {
            if (t1.x < t2.x - DISTANCE_DELTA) {
                return -1;
            }
            if (Math.abs(t1.x - t2.x) <= DISTANCE_DELTA) {
                return 0;
            }
        }
        return 1;
    };

    static areAdjacentBlocksOnX(leftCell, rightCell, distance) {
        let DISTANCE_DELTA_Y = 5;
        // le caractére peut être centré verticalement ex: "-"
        if (rightCell.text.length == 1) DISTANCE_DELTA_Y = leftCell.h * 0.75;

        if (distance === undefined) distance = this.getSpaceThreshHold(leftCell);

        let isInSameLine = Math.abs(leftCell.y - rightCell.y) <= DISTANCE_DELTA_Y;
        if (!isInSameLine) return;

        const cellDistance = rightCell.x - leftCell.x - leftCell.w;
        let isDistanceSmallerThanASpace = cellDistance <= distance && cellDistance >= -leftCell.sw; // je garde une marge (sw) car opentype.js n'est pas pr�cis

        return isDistanceSmallerThanASpace;
    };

    static async writeFile(context, filepath) {
        const stream = context.canvas.createPNGStream();
        await pipelineAsync(
            stream,
            fs.createWriteStream(filepath)
        );
    }

    static async show(context) {
        const output = path.join(os.tmpdir(), `${randomName()}.png`) //path.join(fs.mkdtempSync(`${os.tmpdir()}/pdf-`), );
        await PDFParser.writeFile(context, output);
        await execAsync(`start ${output}`);
    }
}

const ecart = (array) => {
    return array.reduce((p, c, i, arr) => {
        if (i == 0) return p;
        let cur = c;
        if (Array.isArray(c)) cur = c[0];
        let prev = arr[i - 1];
        if (Array.isArray(prev)) prev = prev[1];
        p.push(cur - prev)
        return p;
    }, []);
}

/*
https://github.com/mozilla/pdf.js/blob/master/examples/node/pdf2svg.js
*/
function ReadableSVGStream(options) {
    if (!(this instanceof ReadableSVGStream)) {
        return new ReadableSVGStream(options);
    }
    stream.Readable.call(this, options);
    this.serializer = options.svgElement.getSerializer();
}
util.inherits(ReadableSVGStream, stream.Readable);
// Implements https://nodejs.org/api/stream.html#stream_readable_read_size_1
ReadableSVGStream.prototype._read = function () {
    var chunk;
    while ((chunk = this.serializer.getNext()) !== null) {
        if (!this.push(chunk)) {
            return;
        }
    }
    this.push(null);
};

const writeSvgToFile = (svgElement, filePath) => {
    var readableSvgStream = new ReadableSVGStream({
        svgElement: svgElement,
    });
    var writableStream = fs.createWriteStream(filePath);
    return new Promise(function (resolve, reject) {
        readableSvgStream.once("error", reject);
        writableStream.once("error", reject);
        writableStream.once("finish", resolve);
        readableSvgStream.pipe(writableStream);
    }).catch(function (err) {
        readableSvgStream = null; // Explicitly null because of v8 bug 6512.
        writableStream.end();
        throw err;
    });
}

module.exports = PDFJS;
module.exports.read = PDFParser.read;
module.exports.render = PDFParser.render;
module.exports.renderAsSVG = PDFParser.renderAsSVG;
module.exports.parse = PDFParser.parse;
module.exports.writeFile = PDFParser.writeFile;
module.exports.show = PDFParser.show;
// module.exports.registerFont = NodeCanvasFactory.registerFont;
module.exports.Rect = Rect;
module.exports.ReadableSVGStream = ReadableSVGStream;
module.exports.writeSvgToFile = writeSvgToFile;