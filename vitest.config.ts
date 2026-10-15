import { defineConfig } from "vitest/config";

export default defineConfig({
	define: {
		__SPINDLE_VERSION__: JSON.stringify("0.0.0-test")
	},
	test: {
		globals: true,
		include: ["test/**/*.test.ts"]
	}
});
