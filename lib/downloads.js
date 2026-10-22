// Lead Finder installers offered on /download. The page links to
// /download/<id>, which redirects to `url`, so installer hosting addresses
// never appear on the page. To publish a new version, update VERSION and the
// entries below.

export const VERSION = '1.2.1';

const RELEASE = `https://github.com/ourswebsolutions-ux/lead-getter/releases/download/v${VERSION}`;

export const DOWNLOADS = {
  windows: { file: `Lead-Finder-Setup-${VERSION}.exe`, format: '.exe', size: '116 MB', url: `${RELEASE}/Lead-Finder-Setup-${VERSION}.exe` },
  linux: { file: `lead-finder_${VERSION}_amd64.deb`, format: '.deb', size: '105 MB', url: `${RELEASE}/lead-finder_${VERSION}_amd64.deb` },
  'linux-appimage': { file: `Lead-Finder-${VERSION}-linux-x86_64.AppImage`, format: 'AppImage', size: '134 MB', url: `${RELEASE}/Lead-Finder-${VERSION}-linux-x86_64.AppImage` },
  macos: { file: `Lead-Finder-${VERSION}-mac-x64.dmg`, format: '.dmg', size: '140 MB', url: `${RELEASE}/Lead-Finder-${VERSION}-mac-x64.dmg` },
};

// The visitor's desktop platform from the User-Agent, or null (phones,
// tablets and unknown systems).
export function platformOf(userAgent = '') {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) return null;
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos';
  if (/Linux|X11/i.test(userAgent)) return 'linux';
  return null;
}
