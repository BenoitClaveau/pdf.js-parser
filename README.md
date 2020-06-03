# pdf.js-parser

PDF.js has been modified to export GraphicsCanvas.

1. Synchronize pdf.js

```shell
cd pdf.js
git pull
git pull upstream
git merge upstream/master
// apply patch
```

2. Compile pdf.js

```shell
cd pdf.js
gulp dist-install
copy ./build/dist/build/es5/build/* ../pdf.js-parser/dist
```