/**
 * Expo config plugin: declare Bluetooth hardware as *optional* on Android.
 *
 * `react-native-ble-plx` (with `isBackgroundEnabled`) adds
 * `<uses-feature android:name="android.hardware.bluetooth_le" android:required="true"/>`,
 * and the BLUETOOTH permission makes Google Play infer `android.hardware.bluetooth`
 * as required too. Either hides SurgeonPulse from devices without BLE, although
 * Health Connect import and the simulator work there. This plugin sets both
 * features to `required="false"`; the app checks BLE support at runtime and
 * shows the Bluetooth source as unavailable.
 *
 * Works whichever order the manifest mods run in: if this runs first,
 * ble-plx sees the existing entry and does not add its own.
 */
const { withAndroidManifest } = require('expo/config-plugins');

const OPTIONAL_FEATURES = ['android.hardware.bluetooth_le', 'android.hardware.bluetooth'];

function setOptionalFeatures(manifest) {
  const root = manifest.manifest;
  if (!Array.isArray(root['uses-feature'])) root['uses-feature'] = [];
  for (const name of OPTIONAL_FEATURES) {
    const existing = root['uses-feature'].find((item) => item.$ && item.$['android:name'] === name);
    if (existing) existing.$['android:required'] = 'false';
    else root['uses-feature'].push({ $: { 'android:name': name, 'android:required': 'false' } });
  }
  return manifest;
}

module.exports = function withOptionalBluetooth(config) {
  return withAndroidManifest(config, (cfg) => {
    cfg.modResults = setOptionalFeatures(cfg.modResults);
    return cfg;
  });
};
module.exports.setOptionalFeatures = setOptionalFeatures;
