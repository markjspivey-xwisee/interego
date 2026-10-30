/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads this .cjs configuration through CommonJS. */
const { createRequire } = require('node:module');
const { join } = require('node:path');

const appRequire = createRequire(join(__dirname, 'package.json'));
const electronVersion = appRequire('electron/package.json').version;
const signingRequested = Boolean(process.env.WIN_CSC_LINK || process.env.CSC_LINK);

module.exports = {
  appId: 'dev.interego.pod',
  productName: 'Interego',
  copyright: 'MIT',
  electronVersion,
  directories: {
    app: join(__dirname, '.staging', 'app'),
    output: join(__dirname, 'release'),
    buildResources: join(__dirname, 'assets'),
  },
  // CSS and ComponentsJS resolve their installed JSON and config graph through the filesystem.
  asar: false,
  // The same executable is a GUI and an MCP companion. An inherited Node host
  // environment must never change its entry point or inject runtime options.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
  },
  files: ['dist/**/*', 'index.html', 'assets/icon.png', 'package.json', 'production-graph.json', 'build-info.json', 'node_modules/**/*'],
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  forceCodeSigning: signingRequested,
  publish: null,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    executableName: 'Interego',
    icon: join(__dirname, 'assets', 'icon.ico'),
    // Keep resource editing enabled. Supplied CSC_LINK/WIN_CSC_LINK credentials are honored;
    // without them the preview is unsigned and build-info.json explicitly says so.
    signAndEditExecutable: true,
    signtoolOptions: { signingHashAlgorithms: ['sha256'] },
    artifactName: 'Interego-${version}-windows-${arch}-setup.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Interego',
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
  },
};
