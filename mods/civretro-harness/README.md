# civretro-harness

**Developer tool. Not for end users.**

This is a Civ7 mod that enables autonomous all-AI games to run without any human interaction. It is used by the civretro CLI harness when generating replay data.

## The problem it solves

Civ7 has screens that block gameplay even when the `Autoplay` JS object is activated:

- **Begin screen** (`NOTIFICATION_ADVANCED_START`) - fires at game start; waits for a human click before turns advance.
- **Age Transition screen** (`NOTIFICATION_AGE_TRANSITION`) - fires at each age boundary; waits for a human dedication/legacy choice.

## The fix

### How the game's own guard works

The game's notification handlers in `notification-handlers.js` (`CreateAdvancedStart.activate()` and `CreateAgeTransition.activate()`) already contain a guard:

```javascript
if (Autoplay.isActive) return;   // skip ContextManager.push entirely
```

The harness exploits this: if `Autoplay` is already active when those handlers fire, they short-circuit before ever pushing a screen onto the context stack. No monkey-patching required.

### Eval-time activation

The harness calls `Autoplay.setActive(true)` as the **first statement of the IIFE**, synchronously at module eval time - before any Coherent Gameface notification handler has a chance to run. This is the primary mechanism.

### Belt-and-suspenders event hooks

Coherent Gameface reloads the entire JS context at each age boundary, re-running this script from scratch. The eval-time call handles this automatically. In addition, hooks on `PostGameInitialization`, `GameStarted`, `AutoplayEnded`, and `GameAgeEnded` re-arm Autoplay to cover any edge cases where the context has reset before the IIFE runs.

### Why ContextManager monkey-patching does not work

`ContextManager` is an ES module export in `base-standard`, not a global. It is not accessible from this scope and cannot be patched from here.

## Always-on

The mod activates Autoplay unconditionally when installed and enabled in the Mods browser. There is no runtime opt-in guard - if you do not want it active, disable it in the Mods menu.

## Configuration (optional)

Config is read from `localStorage` key `civretro:config` (written by the launcher before game launch) or from `window.__civretro` as a CDP-injected fallback. All fields are optional - the mod activates Autoplay regardless.

```js
// civretro:config / window.__civretro schema:
{
  turns:     20,    // 0 or absent = unlimited
  observeAs: -1,    // -1 = no camera follow; 1000 = full-vision observer
  returnAs:  0,     // player to return control to when autoplay ends
}
```

## Relationship to the civretro Recorder mod

`civretro-harness` is **separate** from the main `civretro` (Recorder) mod. The Recorder captures and exports per-turn game state to `localStorage`. The Harness only provides the autonomous-game plumbing that makes unattended recording possible.

## Files

```
civretro-harness.modinfo   Mod descriptor (LoadOrder 1000, ShowInBrowser 0)
ui/autoplay-harness.js     Eval-time Autoplay activation + belt-and-suspenders event hooks
README.md                  This file
```
