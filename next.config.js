// Next.js settings. The site and the Lead Getter licence API run in this one
// app (one process); see README.

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // /lead-getter/* paths are passed to the licence API exactly as sent.
  skipTrailingSlashRedirect: true,
  serverExternalPackages: ['@prisma/client', 'nodemailer'],
};

export default nextConfig;
