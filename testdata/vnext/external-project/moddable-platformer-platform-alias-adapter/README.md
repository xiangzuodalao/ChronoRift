# Moddable Platformer platform geometry adapter

This ProjectAdapter V1 is scoped to the default scene in
`endlessm/moddable-platformer` commit
`e78b339500dec8e480b33723c4156bf9b74cd25c` (tree
`9941cb045b3cd73c4554ca1de337a341b383590b`). It projects nodes whose attached
script resource is `res://components/platform/platform.gd`.

The adapter reports authored platform entities and `platform_geometry` state
samples. It emits the first sample, then emits again only when the projected
value or semantic coverage changes. The state contains the scene-relative node
path, configured tile width, rendered sprite count, one-way and fall-time
settings, and the realized solid/area `RectangleShape2D` instance IDs and
widths. It emits no custom events and does not label any observation as a bug,
mismatch, expected value, cause, or fix.

Limitations:

- Sampling begins after the main scene is ready; it does not reconstruct prior
  writes or runtime history.
- Godot instance IDs are strings and are comparable only within one Execution.
- Coverage is limited to matching platform-script nodes in `res://main.tscn`.
- Missing expected child nodes or non-rectangle collision shapes degrade the
  state sample instead of inventing substitute values.
