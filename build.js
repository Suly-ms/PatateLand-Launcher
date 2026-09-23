const fs = require("fs");

const builder = require('electron-builder')
const JavaScriptObfuscator = require('javascript-obfuscator');
const png2icons = require('png2icons');
const { Jimp, JimpMime } = require('jimp');

const { productName } = require('./package.json');

class Index {
    async init() {
        this.obf = true
        this.Fileslist = []
        process.argv.forEach(async val => {
            if (val.startsWith('--icon')) {
                return this.iconSet(val.split('=')[1])
            }

            if (val.startsWith('--obf')) {
                this.obf = JSON.parse(val.split('=')[1])
                this.Fileslist = this.getFiles("src");
            }

            if (val.startsWith('--build')) {
                let buildType = val.split('=')[1]
                if (buildType == 'platform') return await this.buildPlatform()
            }
        });
    }

    async Obfuscate() {
    if (fs.existsSync("./app")) {
        fs.rmSync("./app", { recursive: true });
    }

    for (let path of this.Fileslist) {
        let fileName = path.split('/').pop();
        let extFile = fileName.split(".").pop();
        let folder = path
            .replace(`/${fileName}`, '')
            .replace('src', 'app');

        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder, { recursive: true });
        }

        if (extFile == 'js') {
            let code = fs.readFileSync(path, "utf8");

            // Adapte les chemins éventuels qui utilisent src/
            code = code.replace(/src\//g, 'app/');

            // friends.js reste volontairement non obfusqué
            // pour vérifier si l'obfuscateur est responsable
            // de l'écran blanc.
            const normalizedPath = path.replace(/\\/g, '/');
            const shouldObfuscate =
                this.obf &&
                !normalizedPath.endsWith('/panels/friends.js');

            if (shouldObfuscate) {
                console.log(`Obfuscate ${path}`);

                const obf = JavaScriptObfuscator.obfuscate(code, {
                    optionsPreset: 'medium-obfuscation',
                    disableConsoleOutput: false
                });

                fs.writeFileSync(
                    `${folder}/${fileName}`,
                    obf.getObfuscatedCode(),
                    { encoding: "utf-8" }
                );
            } else {
                console.log(`Copy without obfuscation ${path}`);

                fs.writeFileSync(
                    `${folder}/${fileName}`,
                    code,
                    { encoding: "utf-8" }
                );
            }
        } else {
            console.log(
                `[BUILD DEBUG] Copie de : ${path} -> ${folder}/${fileName}`
            );

            fs.copyFileSync(
                path,
                `${folder}/${fileName}`
            );
        }
    }
}

    async buildPlatform() {
        await this.Obfuscate();
        builder.build({
            config: {
                generateUpdatesFilesForAllChannels: false,
                appId: 'fr.patateland.launcher',
                productName: productName,
                copyright: `Copyright © 2020-${new Date().getFullYear()} Luuxis`,
                artifactName: "${productName}-${os}-${arch}.${ext}",
                extraMetadata: { main: 'app/app.js' },
                files: ["app/**/*", "package.json", "LICENSE.md"],
                // Le jar du mod cosmétiques (test_cosmetics-mod/, un projet
                // Gradle séparé à la racine) n'est PAS du code du launcher —
                // il n'est donc pas concerné par "files"/app.asar ci-dessus.
                // On le copie à part, à plat, dans resources/test_cosmetics-mod/
                // (voir home.js -> process.resourcesPath) sinon le .exe
                // packagé ne trouve jamais le jar et le mod n'est jamais
                // injecté dans les instances (constaté : "j'ai pas le mod"
                // uniquement sur le .exe buildé, jamais en "npm start").
                extraResources: [{
                    from: "test_cosmetics-mod/build/libs",
                    to: "test_cosmetics-mod",
                    filter: ["testcosmetics-*.jar"]
                }],
                directories: {
                    "output": "dist"
                },
                compression: 'normal',
                asar: true,
                electronDownload: {
                    cache: "./node_modules/.cache/electron"
                },
                nodeGypRebuild: false,
                npmRebuild: true,
                publish: [{
                    provider: "github",
                    releaseType: 'release',
                }],
                win: {
                    icon: "./app/assets/images/icon/icon.ico",
                    requestedExecutionLevel: "asInvoker",
                    target: [{
                        target: "nsis",
                        arch: "x64"
                    },
                    {
                        target: "nsis",
                        arch: "arm64"
                    }]
                },
                nsis: {
                    oneClick: true,
                    perMachine: false,
                    allowToChangeInstallationDirectory: false,
                    createDesktopShortcut: true,
                    createStartMenuShortcut: true,
                    shortcutName: "PatateLand",
                    runAfterFinish: true
                },
                mac: {
                    icon: "./app/assets/images/icon/icon.icns",
                    category: "public.app-category.games",
                    identity: null,
                    hardenedRuntime: false,
                    gatekeeperAssess: false,
                    mergeASARs: true,
                    target: [{
                        target: "dmg",
                        arch: "universal"
                    },
                    {
                        target: "zip",
                        arch: "universal"
                    }]
                },
                dmg: {
                    sign: false,
                    contents: [
                        { x: 130, y: 220 },
                        { x: 410, y: 220, type: 'link', path: '/Applications' }
                    ],
                    artifactName: "${productName}-mac-${arch}.${ext}",
                    format: "ULFO"
                },
                linux: {
                    icon: "./app/assets/images/icon/icon.png",
                    target: [{
                        target: "AppImage",
                        arch: "x64"
                    }]
                }
            }
        }).then(() => {
            console.log('le build est terminé')
        }).catch(err => {
            console.error('Error during build!', err)
        })
    }

    getFiles(path, file = []) {
        if (fs.existsSync(path)) {
            let files = fs.readdirSync(path);
            if (files.length == 0) file.push(path);
            for (let i in files) {
                let name = `${path}/${files[i]}`;
                if (fs.statSync(name).isDirectory()) this.getFiles(name, file);
                else file.push(name);
            }
        }
        return file;
    }

    async iconSet() {
        const buffer = fs.readFileSync('src/assets/images/icon/icon.png');
        let image = await Jimp.read(buffer);
        image = await image.resize({ w: 256, h: 256 }).getBuffer(JimpMime.png);
        fs.writeFileSync("src/assets/images/icon/icon.icns", png2icons.createICNS(image, png2icons.BILINEAR, 0));
        fs.writeFileSync("src/assets/images/icon/icon.ico", png2icons.createICO(image, png2icons.HERMITE, 0, false));
        fs.writeFileSync("src/assets/images/icon/icon.png", image);
    }
}

new Index().init();