import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["node_modules/", "out/", "**/bin/", "**/logs/", ".superpowers/", "**/ui/sdpi-components.js"]
	},
	...tseslint.configs.recommended
);
