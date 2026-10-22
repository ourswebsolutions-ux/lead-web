import './globals.css';

export const metadata = {
  title: 'Subscriptions · Axora Web Solutions',
  robots: { index: false, follow: false },
};

// Rendered per request: the page sits behind the admin login and uses a
// per-request CSP nonce (middleware.js).
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
