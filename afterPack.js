// Runs after electron-builder packages the app, before it builds the final
// installer. Electron ships ~50 language files by default; DeepBook Studio
// is English-only, so we drop everything except English to shrink the
// installer meaningfully with zero effect on how the app works.
const fs = require('fs');
const path = require('path');

const KEEP_LOCALES = new Set(['en-US.pak', 'en-GB.pak', 'en.pak']);

module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;

  if (electronPlatformName === 'darwin') {
    try {
      const frameworksDir = path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Frameworks');
      const efDir = fs.readdirSync(frameworksDir).find((f) => f.startsWith('Electron Framework'));
      if (efDir) {
        const resDir = path.join(frameworksDir, efDir, 'Versions', 'A', 'Resources');
        for (const entry of fs.readdirSync(resDir)) {
          if (entry.endsWith('.lproj') && entry !== 'en.lproj' && entry !== 'Base.lproj') {
            fs.rmSync(path.join(resDir, entry), { recursive: true, force: true });
          }
        }
      }
    } catch (e) {
      console.warn('afterPack: locale pruning skipped (mac):', e.message);
    }
    return;
  }

  try {
    const localesDir = path.join(appOutDir, 'locales');
    if (fs.existsSync(localesDir)) {
      for (const file of fs.readdirSync(localesDir)) {
        if (!KEEP_LOCALES.has(file)) fs.unlinkSync(path.join(localesDir, file));
      }
    }
  } catch (e) {
    console.warn('afterPack: locale pruning skipped:', e.message);
  }
};
