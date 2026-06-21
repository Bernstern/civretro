# civretro-harness

**Developer tool. Not for end users.**

This is a Civ7 mod that enables autonomous all-AI games to run without any human interaction. It is used by the civretro CLI harness when generating replay data.

## The problem it solves

Civ7 has screens that block gameplay even when the `Autoplay` JS object is activated:

- **Begin screen** (`NOTIFICATION_ADVANCED_START`) — fires at game start; waits for a human click before turns advance.
- **Age Transition screen** (`NOTIFICATION_AGE_TRANSITION`) — fires at each age boundary; waits for a human dedication/legacy choice.

## The fix

### Primary: `ContextManager.push` monkey-patch

The harness patches `ContextManager.push` at three points: synchronously at module eval time, inside `engine.whenReady.then()`, and on every `PostGameInitialization` event (which fires after age-transition context reloads). The function is idempotent so calling it multiple times is safe. Any push of a blocked screen name is intercepted and swallowed; `activateAutoplay()` is called instead.

```javascript
let _cmPatched = false;
function patchContextManager() {
    if (_cmPatched) return;
    if (typeof ContextManager === "undefined") return;
    const _orig = ContextManager.push.bind(ContextManager);
    ContextManager.push = function (screenName, ...args) {
        if (BLOCKED_SCREENS.has(screenName)) {
            activateAutoplay();
            return Promise.resolve();
        }
        return _orig(screenName, ...args);
    };
    _cmPatched = true;
}
// Called at eval time, in engine.whenReady.then(), and on PostGameInitialization.
```

Blocked names (confirmed from `notification-handlers.js`):
- `"screen-advanced-start"` — Begin screen
- `"screen-dedication-selection"` — age transition dedication/legacy chooser
- `"age-transition-banner"` — age transition overlay

### Secondary: `registerHandler` overrides (inside `engine.whenReady`)

`registerHandler(key, handler)` internally calls `Game.getHash(key)`. At module eval time `Game` isn't ready — the call throws silently and the handler is never registered. Moving the call inside `engine.whenReady.then()` fixes this. These overrides are belt-and-suspenders behind the ContextManager patch.

### Belt-and-suspenders: engine event hooks

Hooks `PostGameInitialization`, `GameStarted`, `GameAgeEnded`, and `AutoplayEnded` also call `activateAutoplay()` to ensure Autoplay is active as early as possible.

## Always-on

The mod drives every game unconditionally when installed and enabled in the Mods browser. There is no runtime opt-in guard — if you don't want it active, disable it in the Mods menu.

## Configuration (optional)

`window.__civretro` can be injected via CDP to control run parameters. All fields are optional — the mod activates Autoplay regardless.

```js
window.__civretro = {
  turns:     20,    // 0 or absent = unlimited
  observeAs: -1,    // -1 = no camera follow; 1000 = full-vision observer
  returnAs:  0,     // player to return control to when autoplay ends
};
```

## Relationship to the civretro mod

`civretro-harness` is **separate** from the main `civretro` (Recorder) mod. The Recorder is what captures and exports game state. The Harness only provides the autonomous-game plumbing that makes unattended recording possible.

## Files

```
civretro-harness.modinfo   Mod descriptor (LoadOrder 1000, ShowInBrowser 0)
ui/autoplay-harness.js     ContextManager patch + notification handler overrides
README.md                  This file
```
