const path = require('node:path');
const CopyPlugin = require('copy-webpack-plugin');

// MV3 bundle: one entry per context. ts-loader compiles with tsconfig.build.json (which
// flips off the typecheck-only `noEmit`). The popup is loaded as an ES module
// (<script type="module">); the others are classic content/worker scripts.
module.exports = {
  mode: 'production',
  devtool: 'source-map',
  entry: {
    'background/service-worker': './src/background/service-worker.ts',
    'popup/popup': './src/popup/popup.ts',
    'sidepanel/sidepanel': './src/sidepanel/sidepanel.ts',
    'content/content-script': './src/content/content-script.ts',
    'inject/inject': './src/inject/inject.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: { configFile: 'tsconfig.build.json' },
        },
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'src/manifest.json', to: 'manifest.json' },
        { from: 'src/popup/popup.html', to: 'popup/popup.html' },
        { from: 'src/popup/popup.css', to: 'popup/popup.css' },
        { from: 'src/sidepanel/sidepanel.html', to: 'sidepanel/sidepanel.html' },
        { from: 'src/sidepanel/sidepanel.css', to: 'sidepanel/sidepanel.css' },
        { from: 'src/icons', to: 'icons' },
        // The static Solid-OIDC Client Identifier Document (see client-id.ts). Shipped so a
        // build can be hosted with the doc alongside; the in-flow client_id points at the
        // eventual HOSTED URL (PUBLISHED_CLIENT_ID_URL), which is a needs:user placeholder.
        { from: 'public/clientid.jsonld', to: 'clientid.jsonld' },
      ],
    }),
  ],
};
