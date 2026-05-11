import UIKit
import Capacitor
import WebKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Inject window.lobuNative at document start so every page load
        // sees the native bridge object synchronously.
        if let bridge = (window?.rootViewController as? CAPBridgeViewController)?.bridge {
            injectLobuNative(into: bridge)
        }
        return true
    }

    // Inject via the bridge's WKWebView directly — Capacitor 8 exposes it via
    // CAPBridgeProtocol. We add a WKUserScript at .atDocumentStart so it runs
    // before any page JavaScript. The script defines window.lobuNative and
    // checks HealthKit availability synchronously (bridge is in the same process).
    private func injectLobuNative(into bridge: CAPBridgeProtocol) {
        let js = """
        (function() {
          'use strict';
          // Avoid double-defining if somehow called twice (e.g. hot reload).
          if (window.lobuNative) return;

          var _capabilities = [];

          // Check HealthKit availability synchronously at inject time.
          // capacitor-health's jsName is 'HealthPlugin'.
          function _checkHealthAvailable() {
            try {
              var plugin = Capacitor && Capacitor.Plugins && Capacitor.Plugins.HealthPlugin;
              if (!plugin) return false;
              // isHealthAvailable is async; we start a probe and update
              // capabilities when it resolves. The capability list starts empty
              // and is updated before the app renders if HealthKit was
              // previously authorised.
              plugin.isHealthAvailable().then(function(res) {
                if (res && res.available) {
                  // Only include 'healthkit' once user has granted permissions.
                  // We can't synchronously check granted status, so we defer
                  // to the requestCapability flow to add it.
                }
              }).catch(function() {});
              return true;
            } catch(e) { return false; }
          }

          _checkHealthAvailable();

          window.lobuNative = {
            platform: 'ios',
            version: '1.0',
            capabilities: _capabilities,
            supportedCapabilities: ['healthkit'],

            requestCapability: function(cap) {
              return new Promise(function(resolve, reject) {
                if (cap !== 'healthkit') {
                  reject(new Error('Unknown capability: ' + cap));
                  return;
                }
                var plugin = Capacitor && Capacitor.Plugins && Capacitor.Plugins.HealthPlugin;
                if (!plugin) {
                  reject(new Error('HealthPlugin not available'));
                  return;
                }
                var permissions = [
                  'READ_STEPS',
                  'READ_DISTANCE',
                  'READ_ACTIVE_CALORIES',
                  'READ_WORKOUTS',
                  'READ_HEART_RATE'
                ];
                plugin.requestHealthPermissions({ permissions: permissions })
                  .then(function(result) {
                    // iOS HealthKit does not reveal per-type authorization
                    // results to third-party apps; the plugin resolves after
                    // the user finishes the authorization sheet.
                    if (window.lobuNative.capabilities.indexOf('healthkit') === -1) {
                      window.lobuNative.capabilities.push('healthkit');
                    }
                    resolve({ capability: 'healthkit', status: 'granted' });
                  })
                  .catch(function(err) {
                    reject(new Error(String(err)));
                  });
              });
            }
          };
        })();
        """

        let userScript = WKUserScript(
            source: js,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        bridge.webView?.configuration.userContentController.addUserScript(userScript)
    }

    func applicationWillResignActive(_ application: UIApplication) {}

    func applicationDidEnterBackground(_ application: UIApplication) {}

    func applicationWillEnterForeground(_ application: UIApplication) {}

    func applicationDidBecomeActive(_ application: UIApplication) {}

    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}
