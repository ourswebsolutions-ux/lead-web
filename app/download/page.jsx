import { headers } from 'next/headers';
import { VERSION, DOWNLOADS, platformOf } from '../../lib/downloads.js';
import s from './download.module.css';

export const metadata = {
  title: 'Download Lead Finder · Axora Web Solutions',
  description: `Download Lead Finder ${VERSION} for Windows, Linux and macOS.`,
  robots: { index: true, follow: false },
};

function WindowsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M3 5.6 10.4 4.5v7.1H3zm8.4-1.2L21 3v8.6h-9.6zM3 12.5h7.4v7.1L3 18.4zm8.4 0H21V21l-9.6-1.4z" />
    </svg>
  );
}

function LinuxIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="13.2" rx="6.2" ry="8.4" fill="currentColor" />
      <ellipse cx="12" cy="15.2" rx="3.9" ry="5.6" fill="var(--icon-bg)" />
      <circle cx="10.2" cy="8.4" r="1.15" fill="var(--icon-bg)" />
      <circle cx="13.8" cy="8.4" r="1.15" fill="var(--icon-bg)" />
      <path fill="#f2b33d" d="M10.3 10.3h3.4L12 12.2z" />
      <ellipse cx="8.3" cy="21.3" rx="2.6" ry="1.1" fill="#f2b33d" />
      <ellipse cx="15.7" cy="21.3" rx="2.6" ry="1.1" fill="#f2b33d" />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M16.4 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.8-3.5.8-.7 0-1.8-.8-3-.8-1.6 0-3 .9-3.8 2.3-1.6 2.8-.4 6.9 1.2 9.2.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.2 0 2-1.1 2.8-2.2.9-1.3 1.2-2.5 1.3-2.6 0 0-2.5-.9-2.5-3.7zM14.1 5.9c.6-.8 1.1-1.8.9-2.9-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.8-.9 2.8 1 .1 2-.5 2.7-1.3z"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={s.btnIcon}>
      <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" />
    </svg>
  );
}

const PLATFORMS = [
  {
    id: 'windows',
    name: 'Windows',
    Icon: WindowsIcon,
    system: 'Windows 10 or 11, 64-bit',
    downloads: [{ id: 'windows', label: 'Download for Windows' }],
  },
  {
    id: 'linux',
    name: 'Linux',
    Icon: LinuxIcon,
    system: 'Ubuntu, Debian and other Linux, 64-bit',
    downloads: [{ id: 'linux', label: 'Download for Linux' }],
    alternative: { id: 'linux-appimage', label: 'Or download the AppImage' },
  },
  {
    id: 'macos',
    name: 'macOS',
    Icon: AppleIcon,
    system: 'Intel Macs',
    downloads: [{ id: 'macos', label: 'Download for macOS' }],
  },
];

const STEPS = [
  { title: 'Windows', text: 'Run the installer. If Windows shows “Windows protected your PC”, choose More info → Run anyway.' },
  { title: 'Linux', text: 'Open the .deb with your software installer, or run:', code: `sudo apt install ./lead-finder_${VERSION}_amd64.deb`, after: 'For the AppImage: make it executable, then run it.' },
  { title: 'macOS', text: 'Open the .dmg and drag Lead Finder to Applications. The first time, right-click the app and choose Open.' },
];

export default async function DownloadPage() {
  const mine = platformOf((await headers()).get('user-agent') || '');

  return (
    <div className={s.page}>
      <header className="top">
        <div className="wrap top-inner">
          <div className="brand">
            <span className="logo" aria-hidden="true">
              A
            </span>
            <div>
              <strong>Axora Web Solutions</strong>
              <span>Downloads</span>
            </div>
          </div>
        </div>
      </header>

      <main className="wrap">
        <section className={s.hero}>
          <span className={s.version}>Version {VERSION}</span>
          <h1 className={s.title}>Lead Finder</h1>
          <p className={s.lead}>
            Find Google Maps businesses that don’t have a website yet, using the Chrome you already have. Every result appears as it’s found, ready to export or contact.
          </p>
          {!mine && <p className={s.mobileNote}>Lead Finder is a desktop app. Open this page on your Windows, Linux or Mac computer to install it.</p>}
        </section>

        <section className={s.grid} aria-label="Downloads">
          {PLATFORMS.map((p) => {
            const recommended = p.id === mine;
            return (
              <article key={p.id} className={`${s.card} ${recommended ? s.recommended : ''}`}>
                {recommended && <span className={s.badge}>Recommended for this computer</span>}
                <div className={s.icon}>
                  <p.Icon />
                </div>
                <h2 className={s.platform}>{p.name}</h2>
                <p className={s.system}>{p.system}</p>
                <div className={s.meta}>
                  <span className={s.format}>{DOWNLOADS[p.downloads[0].id].format}</span>
                  <span>{DOWNLOADS[p.downloads[0].id].size}</span>
                  <span>v{VERSION}</span>
                </div>
                <div className={s.actions}>
                  {p.downloads.map((d) => (
                    <a key={d.id} className={s.button} href={`/download/${d.id}`} download={DOWNLOADS[d.id].file}>
                      <DownloadIcon />
                      {d.label}
                    </a>
                  ))}
                  {/* Same height in every card, so the buttons line up. */}
                  <div className={s.altRow}>
                    {p.alternative && (
                      <a className={s.alt} href={`/download/${p.alternative.id}`} download={DOWNLOADS[p.alternative.id].file}>
                        {p.alternative.label} <span className={s.altMeta}>· {DOWNLOADS[p.alternative.id].size}</span>
                      </a>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </section>

        <section className={s.install}>
          <h2>Installing</h2>
          <div className={s.steps}>
            {STEPS.map((step) => (
              <div key={step.title} className={s.step}>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
                {step.code && <code className={s.cmd}>{step.code}</code>}
                {step.after && <p>{step.after}</p>}
              </div>
            ))}
          </div>
          <p className={s.requires}>Requires Google Chrome 144 or newer. Includes 3 free searches; choose a plan in the app to keep finding leads.</p>
        </section>

        <footer className={s.footer}>© Axora Web Solutions · Lead Finder {VERSION}</footer>
      </main>
    </div>
  );
}
