# Remix

An official plugin for [Noctívago](https://github.com/Venari-Hunt/Noctivago), the Windows ambient sound mixer. Trim, filter, and EQ a single sound, a whole preset's mix, or a Sound Group - with live preview, in one tab with a Sound/Preset/Group mode switch.

## Install

In Noctívago, open **Settings > Community plugins > Browse**, pick **Remix** and click **Install**. Official plugins install even with Restricted mode on.

## Develop

```
npm install
npm run build     # writes main.js
npm test
```

To try a change, copy `manifest.json`, `main.js` and `styles.css` into `%APPDATA%\noctivago-dev\plugins\remix\` (used by a dev build of the app) and restart the app.

## Layout

```
src/
  index.js       entry: exports the plugin class
  domain/        rules and utilities, no DOM (tested in test/)
  components/    the interface
  audio/         Web Audio code for the live preview
test/
```

A plugin can't import the app's own files, so a few app rules are copied here. `test/coreParity.test.js` downloads the app's version from GitHub and fails if a copy drifts apart.

## Release

Bump `version` in `manifest.json`, add it to `versions.json` with its `minAppVersion`, commit, then push a tag equal to the version (`git tag 1.0.1 && git push origin 1.0.1`). The release workflow builds, tests and publishes it.

## License

Apache-2.0
