# React Native plugin

Dedicated views in the chat for Expo, EAS, Metro, Gradle, CocoaPods, Xcode, `adb`, Jest, Detox and Maestro commands, plus analysis cards that extract mobile structures from the JS/TS, Kotlin/Java, Swift/Obj-C and configuration files that are edited and read.

## What changes in the chat

- **Jest, Detox and Maestro (IDE Test Explorer)**: a suite/file-based test tree for unit and E2E flow tests, passed/failed/skipped test cases, success percentage, `Expected` / `Actual` diffs and stack trace
- **Gradle and Xcode**: the BUILD result, task counts, failed tasks, the "What went wrong" block, Kotlin/Swift compile errors, the paths of the APK/AAB files produced
- **expo / react-native run, start, prebuild, bundle**: the development address, module count, bundle time and the bundle files produced
- **EAS build, submit, update**: platform, profile and the cloud build link
- **pod install**: the number of installed pods and the list of added/updated native pods
- **adb devices and logcat**: the table of connected devices and logs at level `E`/`F`
- **Mobile and native code analysis (`files` and `read`)**: `TurboModuleRegistry` (New Architecture) and `NativeModules` bridges, Android `@ReactMethod` and iOS `RCT_EXPORT_METHOD` native methods, React Navigation screens (`Stack.Screen`, `Tabs.Screen`), core RN components (`FlatList`, `Pressable`, `Modal` and others), Reanimated animation hooks, device APIs (`PermissionsAndroid`, `Linking`, `Platform.select`), Android/iOS permissions (`AndroidManifest.xml`, `Info.plist`, `app.json`), Gradle dependencies and `Podfile` pod definitions
- **Status panel**: a panel that shows the Android, iOS and test status

## Installation

Ships with AIWS and is on by default; it can be turned off under **Settings → Plugins**. The plugin uses only the `aiws.conversation` API and has no server code. API: `src/assets/agent-skills/aiws-plugin-development`.
