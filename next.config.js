/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { esmExternals: "loose" },
  webpack: (config) => {
    config.module.rules.push(
      { test: /\.wasm$/, type: "asset/resource" },
      { test: /\.onnx$/, type: "asset/resource" }
    );
    return config;
  },
};
module.exports = nextConfig;
