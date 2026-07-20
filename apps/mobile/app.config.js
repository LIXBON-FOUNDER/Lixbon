// app.config.js — configuración Expo. La versión visible vive en package.json
// (única fuente: el CI comprueba que el tag mobile-vX.Y.Z coincida con ella).
// La carpeta android/ NO se versiona: la genera `expo prebuild` en CI.
const { version } = require('./package.json');

module.exports = {
  expo: {
    name: 'Lixbon',
    slug: 'lixbon',
    version,
    platforms: ['android'],
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    // Esquema del deep link del OAuth (lixbon://oauth), en la allowlist
    // de redirects del gateway.
    scheme: 'lixbon',
    android: {
      package: 'com.usuario.lixbon',
      versionCode: 1,
      edgeToEdgeEnabled: true,
    },
  },
};
