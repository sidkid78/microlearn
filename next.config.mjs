/** @type {import('next').NextConfig} */
const nextConfig = {
  // Turbopack is the default bundler from Next 16. A `webpack` key here
  // makes the build refuse to start ("using Turbopack, with a `webpack`
  // config and no `turbopack` config"), so the extensionAlias trick that
  // worked on 15 is gone. Relative imports are written WITHOUT a .js
  // extension instead, which is what moduleResolution "bundler" expects
  // and what Turbopack resolves natively.
  turbopack: {},

  // Thumbnails are served from Supabase Storage, and `next/image`
  // refuses any host that is not declared here — "Invalid src prop …
  // hostname is not configured under images". That is a runtime error on
  // the page, not a build error, so nothing in the toolchain catches it:
  // tsc, vitest and `next build` all pass and the feed throws the first
  // time it renders a real thumbnail.
  //
  // Both entries are needed. The local Supabase stack serves over http
  // on an allocated 127.0.0.1 port, and a deployed project serves over
  // https from *.supabase.co.
  images: {
    // Next 16 refuses to optimise an image whose host resolves to a
    // private IP, as an SSRF guard. The local Supabase stack is exactly
    // that, so local development needs the escape hatch — and only
    // local development: NODE_ENV is `production` in any deployment.
    dangerouslyAllowLocalIP: process.env.NODE_ENV !== 'production',
    remotePatterns: [
      { protocol: 'http', hostname: '127.0.0.1', pathname: '/storage/v1/object/**' },
      { protocol: 'http', hostname: 'localhost', pathname: '/storage/v1/object/**' },
      { protocol: 'https', hostname: '*.supabase.co', pathname: '/storage/v1/object/**' },
    ],
  },
};

export default nextConfig;
