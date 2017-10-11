var path = require('path')
const CopyPlugin = require('copy-webpack-plugin')

const standalone = /:standalone$/.test(process.env.NODE_ENV)
const filesToCopy = ['manifest.konnector', 'package.json', 'README.md', 'LICENSE']

if (standalone) {
  filesToCopy.push('konnector-dev-config.json')
}

module.exports = {
  entry: './index.js',
  target: 'node',
  output: {
    path: path.join(__dirname, 'build'),
    filename: 'index.js'
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules\/(?!(cozy-konnector-libs)\/).*/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['env']
          }
        }
      }
    ]
  },
  plugins: [
    new CopyPlugin(filesToCopy.map(file => ({ from: file })))
  ]
}
