// app.config.js — configuración Expo. La versión visible vive en package.json
// (única fuente: el CI comprueba que el tag mobile-vX.Y.Z coincida con ella).
// La carpeta android/ NO se versiona: la genera `expo prebuild` en CI.
// Iconos: generados desde apps/web/public/favicon.svg (rombo de la marca).
const { version } = require('./package.json');

// versionCode DERIVADO de la versión: Android se niega a instalar un APK cuyo
// versionCode no sea mayor que el instalado, así que dejarlo fijo mientras
// sube la versión hace que la app "no actualice" al descargarla.
// 0.3.0 → 300 · 1.2.3 → 10203 (monotónico mientras crezca la versión).
const [major, minor, patch] = version.split('.').map((n) => parseInt(n, 10) || 0);
const versionCode = major * 10000 + minor * 100 + patch;

module.exports = {
  expo: {
    name: 'Lixbon',
    slug: 'lixbon',
    version,
    platforms: ['android'],
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    icon: './assets/icon.png',
    // Esquema del deep link del OAuth (lixbon://oauth), en la allowlist
    // de redirects del gateway.
    scheme: 'lixbon',
    android: {
      package: 'com.usuario.lixbon',
      versionCode,
      edgeToEdgeEnabled: true,
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#1B1A17',
      },
      // App Links del control remoto: el QR apunta a https://lixbon.com/remote/…
      // Con la app instalada, Android la abre directo en la sesión; sin ella,
      // el navegador carga la web. autoVerify exige publicar
      // /.well-known/assetlinks.json con la huella SHA-256 del certificado.
      intentFilters: [
        {
          action: 'VIEW',
          autoVerify: true,
          data: [{ scheme: 'https', host: 'lixbon.com', pathPrefix: '/remote/' }],
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
    },
    plugins: [
      [
        'expo-splash-screen',
        {
          image: './assets/splash-icon.png',
          imageWidth: 160,
          backgroundColor: '#F2F1E3',
          dark: { backgroundColor: '#1A1913' },
        },
      ],
    ],
  },
};
