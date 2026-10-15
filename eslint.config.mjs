import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["node_modules/", "out/", "**/bin/", "**/logs/", ".superpowers/"]
	},
	...tseslint.configs.recommended
);
