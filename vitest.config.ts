import { defineConfig } from "vitest/config";

export default defineConfig({
	define: {
		__SPINDLE_VERSION__: JSON.stringify("0.0.0-test"),
		__SPINDLE_CAPTURE__: JSON.stringify(false)
	},
	test: {
		globals: true,
		include: ["test/**/*.test.ts"]
	}
});
