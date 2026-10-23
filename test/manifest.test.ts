import manifest from "../com.vaguedustin.spindle.sdPlugin/manifest.json" with { type: "json" };
import layout from "../com.vaguedustin.spindle.sdPlugin/layouts/spindle.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };

test("manifest pins platform floors", () => {
  expect(manifest.UUID).toBe("com.vaguedustin.spindle");
  expect(manifest.SDKVersion).toBe(3);
  expect(manifest.Nodejs.Version).toBe("24");
  expect(manifest.CodePath).toBe("bin/plugin.js");
  expect(manifest.Software.MinimumVersion).toBe("7.1");
  expect(manifest.Version).toBe(`${pkg.version}.0`);
});
test("four actions: dial, wide, cover, transport", () => {
  expect(manifest.Actions.map((a) => [a.UUID, a.Controllers])).toEqual([
    ["com.vaguedustin.spindle.dial", ["Encoder"]],
    ["com.vaguedustin.spindle.wide", ["Encoder"]],
    ["com.vaguedustin.spindle.cover", ["Keypad"]],
    ["com.vaguedustin.spindle.transport", ["Keypad"]],
  ]);
  expect(manifest.Actions[1].Encoder?.layout).toBe("layouts/spindle.json");
});
test("the dial action is unchanged, so existing profiles keep working", () => {
  const a = manifest.Actions[0];
  expect(a.UUID).toBe("com.vaguedustin.spindle.dial");
  expect(a.Controllers).toEqual(["Encoder"]);
  expect(a.Encoder!.layout).toBe("layouts/spindle.json");
  expect(a.Encoder!.TriggerDescription).toEqual({ Rotate: "Volume / Skip", Push: "Switch mode", Touch: "Play/Pause" });
});
test("layout: bg under fg, both full strip", () => {
  expect(layout.items).toEqual([
    { key: "bg", type: "pixmap", rect: [0, 0, 200, 100], zOrder: 0 },
    { key: "fg", type: "pixmap", rect: [0, 0, 200, 100], zOrder: 1 },
  ]);
});
