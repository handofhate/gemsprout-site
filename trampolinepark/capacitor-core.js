// Browser-safe Capacitor shim for local web testing.
// Native builds inject the real Capacitor runtime instead.
(function () {
  if (window.Capacitor) return;

  window.Capacitor = {
    Plugins: {},
    isNativePlatform: function () {
      return false;
    }
  };
})();
